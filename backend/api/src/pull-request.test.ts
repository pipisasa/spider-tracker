import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  attachRepo,
  createAgent,
  createApiKey,
  createOrganization,
  createProject,
  createRepo,
  createTask,
  pullRequestBodyFor,
  pullRequestTitleFor,
  saveGithubInstallation,
  type ActorContext,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { SpiderApiError, createClient } from "@repo/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { createFakeGithub } from "./github-fake";
import type { Mailer } from "./mailer";

/**
 * A GitHub installation id for this test run. Ids are global on the shared test database, and
 * `Date.now()` plus an offset collided between files and concurrent runs (ST-142): random instead.
 */
const uniqueInstallationId = () =>
  10 ** 12 + Math.floor(Math.random() * 10 ** 12);

// POST /tasks/:key/pull-request and the MCP open_pull_request tool (ST-87), against a fake GitHub.

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

const mailer: Mailer = { async sendMagicLink() {} };
const env = loadEnv({ ...baseEnv, ...githubVars });
const db = createDb(env.DATABASE_URL);
const github = createFakeGithub();
const app = createApp({ db, auth: createAuth(db, env, mailer), env, github });
const plainEnv = loadEnv(baseEnv);
const plainApp = createApp({
  db,
  auth: createAuth(db, plainEnv, mailer),
  env: plainEnv,
});

afterAll(() => db.$client.end());

describe("pull request text (ST-87)", () => {
  test("the title is the task's with its key", () => {
    expect(pullRequestTitleFor("ST-12", "Fix the login")).toBe(
      "Fix the login (ST-12)",
    );
    const long = pullRequestTitleFor("ST-12", "x".repeat(300));
    expect(long.length).toBe(256);
    expect(long).toEndWith("… (ST-12)");
  });

  test("the body always closes the task, once", () => {
    expect(pullRequestBodyFor("ST-12", {})).toBe("Closes ST-12");
    expect(pullRequestBodyFor("ST-12", { taskUrl: "https://t/ST-12" })).toBe(
      "Task: [ST-12](https://t/ST-12)\n\nCloses ST-12",
    );
    expect(
      pullRequestBodyFor("ST-12", { body: "Adds X.\n\nFixes st-12" }),
    ).toBe("Adds X.\n\nFixes st-12");
    // A mention or another task's keyword doesn't close it.
    expect(
      pullRequestBodyFor("ST-12", { body: "About ST-12; fixes ST-3" }),
    ).toBe("About ST-12; fixes ST-3\n\nCloses ST-12");
  });
});

const withDb = databaseUrl ? describe : describe.skip;

withDb("POST /tasks/:key/pull-request (ST-87)", () => {
  const stamp = Date.now();
  const slug = `gh-pr-${stamp}`;
  const userId = `test-${crypto.randomUUID()}`;
  const installationId = uniqueInstallationId();
  const otherInstallationId = uniqueInstallationId();
  const otherSlug = `gh-pr-other-${stamp}`;
  const otherUserId = `test-${crypto.randomUUID()}`;
  const repoName = `app-${stamp}`;
  let owner: ActorContext;
  let token = "";
  let scopedToken = "";
  let guestToken = "";
  const deliveries: string[] = [];

  const sdk = (target = app, as?: string) =>
    createClient({
      baseUrl: env.API_ORIGIN,
      token: as ?? token,
      source: "cli",
      fetch: (input, init) => target.request(input, init),
    });
  const statusOf = async (key: string) => {
    const [, number] = key.split("-");
    const [row] = await db
      .select({
        category: schema.statuses.category,
        name: schema.statuses.name,
      })
      .from(schema.tasks)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.tasks.projectId),
      )
      .innerJoin(schema.statuses, eq(schema.statuses.id, schema.tasks.statusId))
      .where(
        and(
          eq(schema.projects.orgId, owner.orgId),
          eq(schema.projects.key, key.split("-")[0] ?? ""),
          eq(schema.tasks.number, Number(number)),
        ),
      );
    return row?.category;
  };
  const apiError = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(err instanceof SpiderApiError))
      throw new Error(`Expected a SpiderApiError, got ${String(err)}`);
    return err;
  };

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(
      db,
      { id: userId, name: "Owner", email: "o@example.com" },
      { name: "PR Org", slug },
    );
    owner = {
      orgId: created.organization.id,
      actorId: created.actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider", key: "SPI" });
    await createProject(db, owner, { name: "Two repos", key: "TWO" });
    await createProject(db, owner, { name: "No repo", key: "NOR" });
    await createProject(db, owner, { name: "Foreign", key: "FOR" });
    await saveGithubInstallation(db, owner, {
      installation: {
        id: installationId,
        account: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
      },
      repositories: [
        { owner: "acme", name: repoName, defaultBranch: "main" },
        { owner: "acme", name: `${repoName}-web`, defaultBranch: "trunk" },
      ],
    });
    await createRepo(db, owner, { url: `acme/${repoName}-unconnected` });
    await attachRepo(db, owner, "SPI", { repo: `acme/${repoName}` });
    await attachRepo(db, owner, "TWO", { repo: `acme/${repoName}` });
    await attachRepo(db, owner, "TWO", { repo: `acme/${repoName}-web` });
    for (const [project, title] of [
      ["SPI", "Open the pull request"],
      ["SPI", "Draft it first"],
      ["SPI", "Known elsewhere"],
      ["SPI", "Refused"],
      ["SPI", "Scoped"],
      ["SPI", "Answered but not kept"],
      ["TWO", "Pick a repo"],
      ["TWO", "Out of scope"],
      ["NOR", "Nowhere to go"],
      ["FOR", "Another org's installation"],
    ] as const) {
      await createTask(db, owner, project, { title });
    }
    const agent = await createAgent(db, owner, { name: "PR Bot" });
    token = (await createApiKey(db, owner, agent.actor.id, { name: "test" }))
      .secret;

    // An agent scoped to SPI, and a guest (an agent whose role is guest).
    const scoped = await createAgent(db, owner, { name: "Scoped PR Bot" });
    await db
      .update(schema.agents)
      .set({ scoped: true })
      .where(eq(schema.agents.actorId, scoped.actor.id));
    const [spi] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, owner.orgId),
          eq(schema.projects.key, "SPI"),
        ),
      );
    await db
      .insert(schema.agentProjects)
      .values({ agentId: scoped.actor.id, projectId: spi!.id });
    scopedToken = (
      await createApiKey(db, owner, scoped.actor.id, { name: "test" })
    ).secret;
    const guest = await createAgent(db, owner, { name: "Guest PR Bot" });
    guestToken = (
      await createApiKey(db, owner, guest.actor.id, { name: "test" })
    ).secret;
    await db
      .update(schema.actors)
      .set({ role: "guest" })
      .where(eq(schema.actors.id, guest.actor.id));

    // A repo whose installation belongs to another organization.
    await db.insert(schema.user).values({
      id: otherUserId,
      name: "Other",
      email: `${otherUserId}@example.com`,
    });
    const other = await createOrganization(
      db,
      { id: otherUserId, name: "Other", email: "x@example.com" },
      { name: "Other Org", slug: otherSlug },
    );
    await saveGithubInstallation(
      db,
      {
        orgId: other.organization.id,
        actorId: other.actor.id,
        role: "owner",
        source: "ui",
      },
      {
        installation: {
          id: otherInstallationId,
          account: "evil",
          accountType: "Organization",
          repositorySelection: "selected",
          suspended: false,
        },
        repositories: [],
      },
    );
    const foreign = await createRepo(db, owner, {
      url: `acme/${repoName}-foreign`,
    });
    await db
      .update(schema.repos)
      .set({ githubInstallationId: otherInstallationId })
      .where(eq(schema.repos.id, foreign.id));
    await attachRepo(db, owner, "FOR", { repo: `acme/${repoName}-foreign` });
  });

  afterAll(async () => {
    await db
      .delete(schema.githubDeliveries)
      .where(inArray(schema.githubDeliveries.id, deliveries));
    await db
      .delete(schema.organizations)
      .where(inArray(schema.organizations.slug, [slug, otherSlug]));
    await db
      .delete(schema.user)
      .where(inArray(schema.user.id, [userId, otherUserId]));
    await db
      .delete(schema.githubInstallations)
      .where(
        inArray(schema.githubInstallations.id, [
          installationId,
          otherInstallationId,
        ]),
      );
  });

  test("without the App: 503 not_configured", async () => {
    const err = await apiError(
      sdk(plainApp).tasks.openPullRequest(slug, "SPI-1"),
    );
    expect(err.status).toBe(503);
    expect(err.code).toBe("not_configured");
  });

  test("opens it as the App, links it at once and moves the task to In Review", async () => {
    const opened = await sdk().tasks.openPullRequest(slug, "spi-1", {
      head: "spi-1-open-the-pull-request",
    });
    expect(opened).toEqual({
      taskKey: "SPI-1",
      pullRequest: {
        repo: `acme/${repoName}`,
        number: 1,
        title: "Open the pull request (SPI-1)",
        url: `https://github.com/acme/${repoName}/pull/1`,
        state: "open",
        draft: false,
        headBranch: "spi-1-open-the-pull-request",
        baseBranch: "main",
        author: "spider-tracker-test[bot]",
        mergedAt: null,
        closedAt: null,
        updatedAt: expect.any(String),
        via: "closing",
      },
    });
    expect(github.pullRequestRequests.at(-1)).toEqual({
      installationId,
      owner: "acme",
      name: repoName,
      head: "spi-1-open-the-pull-request",
      base: "main",
      title: "Open the pull request (SPI-1)",
      body: `Task: [SPI-1](${env.WEB_ORIGIN}/${slug}/tasks/SPI-1)\n\nCloses SPI-1`,
      draft: false,
    });
    const git = await sdk().tasks.git(slug, "SPI-1");
    expect(git.pullRequests).toEqual([opened.pullRequest]);
    expect(await statusOf("SPI-1")).toBe("in_review");
    // Moved by the @github bot, as GitHub's event would.
    const moves = await db
      .select({ source: schema.activity.source, handle: schema.actors.handle })
      .from(schema.activity)
      .innerJoin(schema.actors, eq(schema.actors.id, schema.activity.actorId))
      .where(
        and(
          eq(schema.activity.orgId, owner.orgId),
          eq(schema.activity.action, "task.updated"),
        ),
      );
    expect(moves).toContainEqual({ source: "git", handle: "github" });
  });

  test("a second one for the branch is 409 with the open PR's URL, without asking GitHub", async () => {
    const asked = github.pullRequestRequests.length;
    const err = await apiError(
      sdk().tasks.openPullRequest(slug, "SPI-1", {
        head: "spi-1-open-the-pull-request",
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("conflict");
    expect(err.url).toBe(`https://github.com/acme/${repoName}/pull/1`);
    expect(err.message).toContain(`https://github.com/acme/${repoName}/pull/1`);
    expect(github.pullRequestRequests.length).toBe(asked);
  });

  test("one GitHub already has is 409 too, and is linked when it names the task", async () => {
    const head = "spi-3-known-elsewhere";
    github.pullRequests.set(`acme/${repoName}`.toLowerCase(), [
      ...(github.pullRequests.get(`acme/${repoName}`.toLowerCase()) ?? []),
      {
        number: 2,
        title: "Opened on GitHub",
        body: null,
        state: "open",
        merged: false,
        draft: false,
        headBranch: head,
        baseBranch: "main",
        author: "someone",
        mergedAt: null,
        closedAt: null,
        updatedAt: "2026-02-01T00:00:00Z",
      },
    ]);
    const err = await apiError(
      sdk().tasks.openPullRequest(slug, "SPI-3", { head }),
    );
    expect(err.status).toBe(409);
    expect(err.url).toBe(`https://github.com/acme/${repoName}/pull/2`);
    const git = await sdk().tasks.git(slug, "SPI-3");
    expect(git.pullRequests).toMatchObject([
      { number: 2, title: "Opened on GitHub", via: "branch" },
    ]);
    // Linked, not moved: its "opened" was long ago.
    expect(await statusOf("SPI-3")).toBe("todo");
  });

  test("--draft opens a draft: the task moves to In Progress; head defaults to the task's branch, title and body can be given", async () => {
    const opened = await sdk().tasks.openPullRequest(slug, "SPI-2", {
      draft: true,
      title: "WIP: drafts",
      body: "First pass.",
    });
    expect(opened.pullRequest).toMatchObject({
      draft: true,
      title: "WIP: drafts",
      headBranch: "spi-2-draft-it-first",
      via: "closing",
    });
    expect(github.pullRequestRequests.at(-1)).toMatchObject({
      body: "First pass.\n\nCloses SPI-2",
      draft: true,
    });
    expect(await statusOf("SPI-2")).toBe("in_progress");
  });

  test("GitHub refusing it is 400 with its reason; GitHub down is 502", async () => {
    github.refusePullRequests = "No commits between main and spi-4-refused";
    try {
      const err = await apiError(sdk().tasks.openPullRequest(slug, "SPI-4"));
      expect(err.status).toBe(400);
      expect(err.message).toContain(
        "No commits between main and spi-4-refused",
      );
    } finally {
      github.refusePullRequests = null;
    }
    github.down = true;
    try {
      const err = await apiError(sdk().tasks.openPullRequest(slug, "SPI-4"));
      expect(err.status).toBe(502);
      expect(err.code).toBe("github_unavailable");
    } finally {
      github.down = false;
    }
    expect(await statusOf("SPI-4")).toBe("todo");
  });

  test("the repo: the only attached one, or the one named among several", async () => {
    const several = await apiError(sdk().tasks.openPullRequest(slug, "TWO-1"));
    expect(several.status).toBe(400);
    expect(several.message).toContain(
      `several repos (acme/${repoName}, acme/${repoName}-web)`,
    );

    const other = await apiError(
      sdk().tasks.openPullRequest(slug, "TWO-1", {
        repo: `acme/${repoName}-unconnected`,
      }),
    );
    expect(other.status).toBe(400);
    expect(other.message).toContain("isn't attached to project TWO");

    const opened = await sdk().tasks.openPullRequest(slug, "TWO-1", {
      repo: `git@github.com:ACME/${repoName}-web.git`,
    });
    expect(opened.pullRequest).toMatchObject({
      repo: `acme/${repoName}-web`,
      baseBranch: "trunk",
      number: 1,
    });

    const none = await apiError(sdk().tasks.openPullRequest(slug, "NOR-1"));
    expect(none.status).toBe(400);
    expect(none.message).toContain("Project NOR has no repo");
  });

  test("a repo the App can't reach, invalid input, a missing task", async () => {
    await attachRepo(db, owner, "NOR", {
      repo: `acme/${repoName}-unconnected`,
    });
    const unconnected = await apiError(
      sdk().tasks.openPullRequest(slug, "NOR-1"),
    );
    expect(unconnected.status).toBe(400);
    expect(unconnected.message).toContain("The GitHub App has no access");

    expect(
      (
        await apiError(
          sdk().tasks.openPullRequest(slug, "SPI-4", { head: "bad..branch" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await apiError(
          sdk().tasks.openPullRequest(slug, "SPI-4", { head: "main" }),
        )
      ).message,
    ).toContain("is the base branch");
    expect(
      (await apiError(sdk().tasks.openPullRequest(slug, "SPI-99"))).status,
    ).toBe(404);
  });

  test("access: a guest is 403, an agent scoped out of the task's project 404, another org's installation 400", async () => {
    const asked = github.pullRequestRequests.length;
    const guest = await apiError(
      sdk(app, guestToken).tasks.openPullRequest(slug, "SPI-5"),
    );
    expect(guest.status).toBe(403);
    const outOfScope = await apiError(
      sdk(app, scopedToken).tasks.openPullRequest(slug, "TWO-2"),
    );
    expect(outOfScope.status).toBe(404);
    const foreign = await apiError(sdk().tasks.openPullRequest(slug, "FOR-1"));
    expect(foreign.status).toBe(400);
    expect(foreign.message).toContain("The GitHub App has no access");
    expect(github.pullRequestRequests.length).toBe(asked);
  });

  test("a scoped agent can't link or move a task outside its projects through the branch, title or body (ST-144)", async () => {
    const asked = github.pullRequestRequests.length;
    for (const input of [
      { body: "Closes TWO-2" },
      { title: "Scoped (TWO-2)" },
      { head: "two-2-out-of-scope" },
      { body: "See two-2" },
      // A task that doesn't exist in that project gets the same answer (ST-146).
      { body: "Closes TWO-999" },
    ]) {
      const err = await apiError(
        sdk(app, scopedToken).tasks.openPullRequest(slug, "SPI-5", input),
      );
      expect(err.status).toBe(404);
      expect(err.message).not.toContain("TWO");
    }
    expect(github.pullRequestRequests.length).toBe(asked);
    expect(await statusOf("TWO-2")).toBe("todo");
    expect((await sdk().tasks.git(slug, "TWO-2")).pullRequests).toEqual([]);

    // Keys of its own projects, and look-alikes that aren't tasks here, are fine.
    const opened = await sdk(app, scopedToken).tasks.openPullRequest(
      slug,
      "SPI-5",
      { head: "spi-5-scoped", body: "After SPI-3; UTF-8 safe" },
    );
    expect(opened.pullRequest).toMatchObject({
      headBranch: "spi-5-scoped",
      via: "closing",
    });
    expect(await statusOf("SPI-5")).toBe("in_review");
  });

  test("a pull request GitHub opened but that isn't kept is still answered, as the same DTO (ST-146)", async () => {
    // GitHub answers with a PR that names no task here (so it isn't saved): the fallback DTO.
    let number = -1;
    const odd = createApp({
      db,
      auth: createAuth(db, env, mailer),
      env,
      github: {
        ...github,
        async createPullRequest(request) {
          const result = await github.createPullRequest(request);
          number = result.pullRequest.number;
          return {
            ...result,
            pullRequest: {
              ...result.pullRequest,
              title: "Unrelated",
              body: null,
              headBranch: "unrelated-work",
            },
          };
        },
      },
    });
    const opened = await sdk(odd).tasks.openPullRequest(slug, "SPI-6", {
      head: "spi-6-not-kept",
    });
    expect(opened).toEqual({
      taskKey: "SPI-6",
      pullRequest: {
        repo: `acme/${repoName}`,
        number,
        title: "Unrelated",
        url: `https://github.com/acme/${repoName}/pull/${number}`,
        state: "open",
        draft: false,
        headBranch: "unrelated-work",
        baseBranch: "main",
        author: "spider-tracker-test[bot]",
        mergedAt: null,
        closedAt: null,
        updatedAt: expect.any(String),
        via: "body",
      },
    });
    expect((await sdk().tasks.git(slug, "SPI-6")).pullRequests).toEqual([]);
    expect(await statusOf("SPI-6")).toBe("todo");
  });

  test("only the task asked for moves at once; others it names (in scope) are linked", async () => {
    const opened = await sdk().tasks.openPullRequest(slug, "TWO-2", {
      repo: `acme/${repoName}`,
      head: "two-2-with-spi",
      body: "Also fixes SPI-3",
    });
    expect(opened.pullRequest.via).toBe("closing");
    expect(await statusOf("TWO-2")).toBe("in_review");
    expect(await statusOf("SPI-3")).toBe("todo");
    expect((await sdk().tasks.git(slug, "SPI-3")).pullRequests).toContainEqual(
      expect.objectContaining({
        number: opened.pullRequest.number,
        via: "closing",
      }),
    );
  });

  test("MCP open_pull_request returns what the API does (as spider pr --json)", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${env.API_ORIGIN}/mcp`),
      {
        fetch: async (url, init) => app.request(url, init),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    const client = new Client({ name: "spider-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      type ToolText = {
        content: { type: string; text: string }[];
        isError?: boolean;
      };
      const call = async (args: Record<string, unknown>) => {
        const result = (await client.callTool({
          name: "open_pull_request",
          arguments: args,
        })) as ToolText;
        return {
          isError: result.isError ?? false,
          text: result.content[0]?.text ?? "",
        };
      };
      const opened = await call({ key: "SPI-4", head: "spi-4-from-mcp" });
      expect(opened.isError).toBe(false);
      const json = JSON.parse(opened.text) as {
        taskKey: string;
        pullRequest: { number: number };
      };
      expect(json).toEqual({
        taskKey: "SPI-4",
        pullRequest: (await sdk().tasks.git(slug, "SPI-4")).pullRequests[0]!,
      });

      const again = await call({ key: "SPI-4", head: "spi-4-from-mcp" });
      expect(again).toEqual({
        isError: true,
        text: expect.stringContaining(`/pull/${json.pullRequest.number}`),
      });
    } finally {
      await client.close();
    }
  });

  test("GitHub's own events for a PR it opened pass the automation guards: its merge into main moves the task to Done", async () => {
    // As GitHub sends them for the App's PR: a branch of the repo, the App's bot as author (NONE).
    const merged = (number: number, head: string, base: string) =>
      JSON.stringify({
        action: "closed",
        number,
        installation: { id: installationId },
        repository: {
          name: repoName,
          owner: { login: "acme" },
          default_branch: "main",
        },
        sender: { login: "ann", type: "User" },
        pull_request: {
          number,
          title: "Open the pull request (SPI-1)",
          body: "Closes SPI-1",
          state: "closed",
          draft: false,
          merged: true,
          merged_at: "2026-10-12T12:00:00Z",
          closed_at: "2026-10-12T12:00:00Z",
          updated_at: "2026-10-12T12:00:00Z",
          head: { ref: head, repo: { full_name: `acme/${repoName}` } },
          base: { ref: base },
          user: { login: "spider-tracker-test[bot]", type: "Bot" },
          author_association: "NONE",
        },
      });
    const post = async (body: string) => {
      const delivery = crypto.randomUUID();
      deliveries.push(delivery);
      const signature = `sha256=${createHmac("sha256", githubVars.GITHUB_APP_WEBHOOK_SECRET).update(body).digest("hex")}`;
      const res = await app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256": signature,
        },
        body,
      });
      return ((await res.json()) as { status: string }).status;
    };
    expect(await statusOf("SPI-1")).toBe("in_review");
    expect(await post(merged(1, "spi-1-open-the-pull-request", "main"))).toBe(
      "processed",
    );
    expect(await statusOf("SPI-1")).toBe("done");
    const [move] = await db
      .select({ changes: schema.activity.changes })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.orgId, owner.orgId),
          eq(schema.activity.action, "task.updated"),
        ),
      )
      .orderBy(desc(schema.activity.id))
      .limit(1);
    expect(move?.changes).toMatchObject({
      pullRequest: { number: 1, event: "merged", sender: "ann" },
    });
  });
});
