import { afterAll, describe, expect, test } from "bun:test";
import type {
  ActorDto,
  GithubInstallationDto,
  GithubInstallUrlDto,
  GithubStatusDto,
  ListResponse,
  RepoDto,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { githubAppConfig, loadEnv } from "./env";
import { createGithubApp } from "./github";
import { createFakeGithub } from "./github-fake";
import type { Mailer } from "./mailer";

const databaseUrl = process.env.TEST_DATABASE_URL;

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
};

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const githubVars = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "spider-tracker-test",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
};

describe("GitHub App settings (ST-82)", () => {
  test("unset or empty: the feature is off", () => {
    expect(githubAppConfig(loadEnv(baseEnv))).toBeNull();
    const empty = Object.fromEntries(
      Object.keys(githubVars).map((k) => [k, ""]),
    );
    expect(githubAppConfig(loadEnv({ ...baseEnv, ...empty }))).toBeNull();
  });

  test("all set: the key may be the PEM or its base64", () => {
    const config = githubAppConfig(loadEnv({ ...baseEnv, ...githubVars }));
    expect(config).toMatchObject({
      appId: "123456",
      slug: "spider-tracker-test",
      clientId: "Iv1.abc",
    });
    expect(config?.privateKey).toBe(pem.endsWith("\n") ? pem : `${pem}\n`);
    // As a single line with escaped newlines, as some secret stores keep it.
    const escaped = githubAppConfig(
      loadEnv({
        ...baseEnv,
        ...githubVars,
        GITHUB_APP_PRIVATE_KEY: pem.trim().replace(/\n/g, "\\n"),
      }),
    );
    expect(escaped?.privateKey).toBe(config?.privateKey ?? "");
  });

  test("the Octokit client builds from the settings (no request is made)", () => {
    const config = githubAppConfig(loadEnv({ ...baseEnv, ...githubVars }));
    if (!config) throw new Error("expected a config");
    const client = createGithubApp(config);
    expect(client.slug).toBe("spider-tracker-test");
    expect(client.installUrl("a.b+c")).toBe(
      "https://github.com/apps/spider-tracker-test/installations/new?state=a.b%2Bc",
    );
  });

  test("all or none, a numeric App ID and a real key", () => {
    const partial: Record<string, string> = { ...githubVars };
    delete partial.GITHUB_APP_SLUG;
    delete partial.GITHUB_APP_CLIENT_SECRET;
    expect(() => loadEnv({ ...baseEnv, ...partial })).toThrow(
      "GITHUB_APP_SLUG, GITHUB_APP_CLIENT_SECRET: Required with the other GITHUB_APP_* variables",
    );
    expect(() =>
      loadEnv({ ...baseEnv, ...githubVars, GITHUB_APP_ID: "spider" }),
    ).toThrow("GITHUB_APP_ID");
    expect(() =>
      loadEnv({
        ...baseEnv,
        ...githubVars,
        GITHUB_APP_PRIVATE_KEY: "not a key",
      }),
    ).toThrow("GITHUB_APP_PRIVATE_KEY");
  });
});

const sentLinks = new Map<string, string>();
const mailer: Mailer = {
  async sendMagicLink(email, url) {
    sentLinks.set(email, url);
  },
};

const env = loadEnv({ ...baseEnv, ...githubVars });
const db = createDb(env.DATABASE_URL);
const auth = createAuth(db, env, mailer);
const github = createFakeGithub();
const app = createApp({ db, auth, env, github });
// The same server without the App.
const plainEnv = loadEnv(baseEnv);
const plainApp = createApp({
  db,
  auth: createAuth(db, plainEnv, mailer),
  env: plainEnv,
});

afterAll(() => db.$client.end());

describe("GitHub routes without the App", () => {
  test("setup answers 503 before anything else", async () => {
    const res = await plainApp.request(
      "/github/setup?installation_id=1&state=x",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: "not_configured" },
    });
  });
});

const withDb = databaseUrl ? describe : describe.skip;

async function signIn(email: string): Promise<string> {
  await app.request("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
    body: JSON.stringify({ email, callbackURL: `${env.WEB_ORIGIN}/` }),
  });
  const link = new URL(sentLinks.get(email) ?? "");
  const verify = await app.request(link.pathname + link.search, {
    redirect: "manual",
  });
  return verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

withDb("GitHub install flow (ST-82)", () => {
  const stamp = Date.now();
  const slug = `gh-api-${stamp}`;
  const otherSlug = `gh-api-other-${stamp}`;
  const emails = [
    `gh-owner-${stamp}@example.com`,
    `gh-member-${stamp}@example.com`,
    `gh-other-${stamp}@example.com`,
  ];
  const installationId = stamp;
  let owner = "";
  let member = "";
  let otherOwner = "";
  let agentKey = "";

  const call = (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    target = app,
  ) =>
    target.request(path, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** POST /github/install as `cookie` in `org`, then the state GitHub would send back. */
  async function startInstall(cookie: string, org = slug): Promise<string> {
    const res = await call(cookie, "POST", `/v1/orgs/${org}/github/install`);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as GithubInstallUrlDto;
    expect(url).toStartWith(
      "https://github.com/apps/spider-tracker-test/installations/new?state=",
    );
    return new URL(url).searchParams.get("state") ?? "";
  }

  const setup = (cookie: string, query: Record<string, string>) =>
    app.request(`/github/setup?${new URLSearchParams(query)}`, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: "manual",
    });

  afterAll(async () => {
    for (const s of [slug, otherSlug])
      await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.slug, s));
    for (const email of emails)
      await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("setup: an organization, a member, an agent and a repo added by URL", async () => {
    owner = await signIn(emails[0] ?? "");
    member = await signIn(emails[1] ?? "");
    otherOwner = await signIn(emails[2] ?? "");
    await call(owner, "POST", "/v1/organizations", {
      name: "GitHub API",
      slug,
    });
    await call(otherOwner, "POST", "/v1/organizations", {
      name: "Other",
      slug: otherSlug,
    });
    await call(owner, "POST", `/v1/orgs/${slug}/projects`, {
      name: "Spider",
      key: "ST",
    });
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    const [memberUser] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, emails[1] ?? ""));
    await db.insert(schema.actors).values({
      orgId: org?.id ?? "",
      type: "human",
      userId: memberUser?.id,
      name: "Member",
      handle: "member",
      role: "member",
    });
    const agent = (await (
      await call(owner, "POST", `/v1/orgs/${slug}/agents`, { name: "Bot" })
    ).json()) as { actor: { id: string } };
    agentKey = (
      (await (
        await call(
          owner,
          "POST",
          `/v1/orgs/${slug}/agents/${agent.actor.id}/keys`,
          { name: "t" },
        )
      ).json()) as { secret: string }
    ).secret;
    expect(
      (
        await call(owner, "POST", `/v1/orgs/${slug}/repos`, {
          url: "acme/web",
          projects: ["ST"],
        })
      ).status,
    ).toBe(201);

    github.installations.set(installationId, {
      installation: {
        id: installationId,
        account: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
      },
      repos: [
        { owner: "acme", name: "web", defaultBranch: "main" },
        { owner: "acme", name: "api", defaultBranch: "main" },
      ],
    });
  });

  test("without the App: GET says not configured, the rest answer 503", async () => {
    const status = (await (
      await call(owner, "GET", `/v1/orgs/${slug}/github`, undefined, plainApp)
    ).json()) as GithubStatusDto;
    expect(status).toEqual({
      configured: false,
      appSlug: null,
      installations: [],
    });
    for (const [method, path] of [
      ["POST", "/github/install"],
      ["POST", `/github/installations/${installationId}/sync`],
    ] as const) {
      const res = await call(
        owner,
        method,
        `/v1/orgs/${slug}${path}`,
        undefined,
        plainApp,
      );
      expect(res.status).toBe(503);
    }
  });

  test("only owners and admins, signed in as people, start the install", async () => {
    expect(
      (await call(member, "POST", `/v1/orgs/${slug}/github/install`)).status,
    ).toBe(403);
    const asAgent = await app.request(`/v1/orgs/${slug}/github/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentKey}` },
    });
    expect(asAgent.status).toBe(403);
    expect(
      await (await call(owner, "GET", `/v1/orgs/${slug}/github`)).json(),
    ).toEqual({
      configured: true,
      appSlug: "spider-tracker-test",
      installations: [],
    });
  });

  test("the callback refuses a missing session, someone else's state and a forged one", async () => {
    const state = await startInstall(owner);
    const query = {
      installation_id: String(installationId),
      setup_action: "install",
      state,
      code: "c-1",
    };
    expect((await setup("", query)).status).toBe(401);
    expect((await setup(member, query)).status).toBe(403);
    expect(
      (await setup(owner, { ...query, state: `${state.slice(0, -2)}xx` }))
        .status,
    ).toBe(400);
    // Nothing was connected.
    expect(
      await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, installationId)),
    ).toEqual([]);
  });

  test("the person must prove they can access the installation", async () => {
    const back = (res: Response) =>
      new URL(res.headers.get("location") ?? "").searchParams;
    // A state works once: each callback gets a new one.
    const callback = async (query: Record<string, string> = {}) =>
      setup(owner, {
        installation_id: String(installationId),
        setup_action: "install",
        state: await startInstall(owner),
        ...query,
      });

    const noCode = await callback();
    expect(noCode.status).toBe(302);
    expect(noCode.headers.get("location")).toStartWith(
      `${env.WEB_ORIGIN}/${slug}/settings/github?`,
    );
    expect(back(noCode).get("error")).toBe("not_verified");

    github.codes.set("other-account", [999]);
    expect(back(await callback({ code: "other-account" })).get("error")).toBe(
      "no_access",
    );
    expect(
      back(await callback({ installation_id: "abc", code: "x" })).get("error"),
    ).toBe("missing_installation");
    expect(
      back(await callback({ setup_action: "request" })).get("requested"),
    ).toBe("1");

    github.down = true;
    github.codes.set("down", [installationId]);
    expect(back(await callback({ code: "down" })).get("error")).toBe(
      "github_unavailable",
    );
    github.down = false;
  });

  test("a used state is refused (ST-137)", async () => {
    const state = await startInstall(owner);
    const query = {
      installation_id: String(installationId),
      setup_action: "install",
      state,
      code: "used-1",
    };
    expect((await setup(owner, query)).status).toBe(302);
    const again = await setup(owner, { ...query, code: "used-2" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("already used");
  });

  test("a failed code exchange logs neither the client secret nor the code (ST-137)", async () => {
    // The real Octokit client, its network replaced: GitHub answers the code exchange with a 500.
    const config = githubAppConfig(env);
    if (!config) throw new Error("expected a config");
    const requests: string[] = [];
    const octokitApp = createApp({
      db,
      auth,
      env,
      github: createGithubApp(config, {
        fetch: async (input, init) => {
          requests.push(
            `${init?.method ?? "GET"} ${input instanceof Request ? input.url : String(input)} ${typeof init?.body === "string" ? init.body : ""}`,
          );
          return Response.json({ message: "Server Error" }, { status: 500 });
        },
      }),
    });
    const code = `code-${crypto.randomUUID()}`;
    const state = await startInstall(owner);

    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    let res: Response;
    try {
      res = await octokitApp.request(
        `/github/setup?${new URLSearchParams({ installation_id: String(installationId), setup_action: "install", state, code })}`,
        { headers: { Cookie: owner }, redirect: "manual" },
      );
    } finally {
      console.error = original;
    }
    expect(
      new URL(res.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("github_unavailable");
    // The request did carry both, so the check below means something.
    expect(requests.join("\n")).toContain(config.clientSecret);
    expect(requests.join("\n")).toContain(code);

    const output = logged
      .map((args) =>
        args
          .map((a) =>
            typeof a === "string" ? a : Bun.inspect(a, { depth: 20 }),
          )
          .join(" "),
      )
      .join("\n");
    expect(output).toBe(
      "GitHub request failed: OAuth code exchange (status 500, POST https://github.com/login/oauth/access_token)",
    );
    expect(output).not.toContain(config.clientSecret);
    expect(output).not.toContain(code);
  });

  test("a verified callback connects the installation and attaches the existing repo", async () => {
    const state = await startInstall(owner);
    github.codes.set("good", [installationId]);
    const res = await setup(owner, {
      installation_id: String(installationId),
      setup_action: "install",
      state,
      code: "good",
    });
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/${slug}/settings/github?connected=${installationId}`,
    );

    const status = (await (
      await call(owner, "GET", `/v1/orgs/${slug}/github`)
    ).json()) as GithubStatusDto;
    expect(status.installations).toMatchObject([
      { id: installationId, account: "acme", repos: ["acme/api", "acme/web"] },
    ]);
    const repos = (await (
      await call(owner, "GET", `/v1/orgs/${slug}/repos`)
    ).json()) as ListResponse<RepoDto>;
    expect(
      repos.items.map((r) => [r.fullName, r.githubInstallationId, r.projects]),
    ).toEqual([
      ["acme/api", installationId, []],
      ["acme/web", installationId, ["ST"]],
    ]);

    // The bot is named in ?all=true, never offered in pickers.
    const members = (await (
      await call(owner, "GET", `/v1/orgs/${slug}/members`)
    ).json()) as ListResponse<ActorDto>;
    expect(members.items.some((m) => m.type === "integration")).toBe(false);
    const all = (await (
      await call(owner, "GET", `/v1/orgs/${slug}/members?all=true`)
    ).json()) as ListResponse<ActorDto>;
    expect(all.items.find((m) => m.type === "integration")).toMatchObject({
      handle: "github",
      name: "GitHub",
      deactivated: false,
    });
  });

  test("another organization can't take the same installation", async () => {
    const state = await startInstall(otherOwner, otherSlug);
    github.codes.set("other-org", [installationId]);
    const res = await setup(otherOwner, {
      installation_id: String(installationId),
      setup_action: "install",
      state,
      code: "other-org",
    });
    expect(
      new URL(res.headers.get("location") ?? "").searchParams.get("error"),
    ).toBe("other_organization");
  });

  test("without our state (a change made on GitHub) the callback just returns to the app", async () => {
    const res = await setup(owner, {
      installation_id: String(installationId),
      setup_action: "update",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(env.WEB_ORIGIN);
  });

  test("sync picks up repository changes; GitHub being down is a 502", async () => {
    github.installations.set(installationId, {
      installation: {
        id: installationId,
        account: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
      },
      repos: [{ owner: "acme", name: "web", defaultBranch: "main" }],
    });
    const synced = await call(
      owner,
      "POST",
      `/v1/orgs/${slug}/github/installations/${installationId}/sync`,
    );
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as GithubInstallationDto).repos).toEqual([
      "acme/web",
    ]);
    expect(
      (
        await call(
          member,
          "POST",
          `/v1/orgs/${slug}/github/installations/${installationId}/sync`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          owner,
          "POST",
          `/v1/orgs/${slug}/github/installations/12/sync`,
        )
      ).status,
    ).toBe(404);

    github.down = true;
    const down = await call(
      owner,
      "POST",
      `/v1/orgs/${slug}/github/installations/${installationId}/sync`,
    );
    github.down = false;
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({
      error: { code: "github_unavailable" },
    });

    github.installations.delete(installationId);
    expect(
      (
        await call(
          owner,
          "POST",
          `/v1/orgs/${slug}/github/installations/${installationId}/sync`,
        )
      ).status,
    ).toBe(404);
  });

  test("disconnect keeps the repos", async () => {
    expect(
      (
        await call(
          member,
          "DELETE",
          `/v1/orgs/${slug}/github/installations/${installationId}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          owner,
          "DELETE",
          `/v1/orgs/${slug}/github/installations/${installationId}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          owner,
          "DELETE",
          `/v1/orgs/${slug}/github/installations/${installationId}`,
        )
      ).status,
    ).toBe(404);
    const repos = (await (
      await call(owner, "GET", `/v1/orgs/${slug}/repos`)
    ).json()) as ListResponse<RepoDto>;
    expect(repos.items.map((r) => r.githubInstallationId)).toEqual([
      null,
      null,
    ]);
  });
});
