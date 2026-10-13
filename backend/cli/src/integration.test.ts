import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "@repo/api/src/app";
import { createAuth } from "@repo/api/src/auth";
import { loadEnv } from "@repo/api/src/env";
import type { Mailer } from "@repo/api/src/mailer";
import {
  handleGithubWebhook,
  saveGithubInstallation,
  type ActorContext,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { and, eq, like } from "drizzle-orm";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { boardColumns } from "@repo/core/board";
import { createClient } from "@repo/sdk";
import { run } from "./cli";
import type { Store } from "./credentials";

// Runs the CLI against the real API app (no network), with a fresh org, project and agent key.

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDb = databaseUrl ? describe : describe.skip;

withDb("spider CLI against the API", () => {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  });
  const links = new Map<string, string>();
  const mailer: Mailer = {
    async sendMagicLink(email, url) {
      links.set(email, url);
    },
  };
  const db = createDb(env.DATABASE_URL);
  const app = createApp({ db, auth: createAuth(db, env, mailer), env });

  const stamp = Date.now();
  const ownerEmail = `cli-owner-${stamp}@example.com`;
  const slug = `cli-${stamp}`;
  let token = "";
  let agentId = "";
  const repo = mkdtempSync(join(tmpdir(), "spider-cli-"));
  let stdin = "";

  afterAll(async () => {
    rmSync(repo, { recursive: true, force: true });
    await db
      .delete(schema.githubDeliveries)
      .where(like(schema.githubDeliveries.id, `${stamp}-cli-%`));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, ownerEmail));
    await db.$client.end();
  });

  const spider = (...argv: string[]) =>
    spiderVia((input, init) => app.request(input, init), argv);
  /** With a config dir, the CLI uses its saved agents instead of the agent key; other entries add to the key's env. */
  const spiderAs = (argv: string[], extra: Record<string, string> = {}) =>
    spiderVia((input, init) => app.request(input, init), argv, extra);

  async function spiderVia(
    fetch: (input: string, init: RequestInit) => Response | Promise<Response>,
    argv: string[],
    runEnv?: Record<string, string>,
  ) {
    let stdout = "";
    let stderr = "";
    const code = await run(argv, {
      env: runEnv?.SPIDER_CONFIG_DIR
        ? runEnv
        : { SPIDER_TOKEN: token, SPIDER_API_URL: env.API_ORIGIN, ...runEnv },
      fetch,
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s) },
      cwd: repo,
      stdin: async () => stdin,
    });
    return {
      code,
      stdout,
      stderr,
      json: () => JSON.parse(stdout) as Record<string, unknown>,
    };
  }

  test("owner sets up a project and an agent key", async () => {
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        email: ownerEmail,
        callbackURL: `${env.WEB_ORIGIN}/`,
      }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const verify = await app.request(link.pathname + link.search, {
      redirect: "manual",
    });
    const cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const post = async <T = unknown>(path: string, body: unknown) => {
      const res = await app.request(path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    };

    await post("/v1/organizations", { name: "CLI Org", slug });
    await post(`/v1/orgs/${slug}/projects`, { name: "Spider", key: "SPI" });
    const agent = await post<{ actor: { id: string } }>(
      `/v1/orgs/${slug}/agents`,
      { name: "CLI Bot" },
    );
    agentId = agent.actor.id;
    const key = await post<{ secret: string }>(
      `/v1/orgs/${slug}/agents/${agentId}/keys`,
      { name: "cli" },
    );
    token = key.secret;
    expect(token).toStartWith("spt_");
  });

  test("whoami and projects", async () => {
    const who = await spider("whoami", "--json");
    expect(who.code).toBe(0);
    expect(who.json()).toMatchObject({
      actor: { id: agentId },
      organization: { slug },
    });
    expect((await spider("projects")).stdout).toBe("SPI  Spider\n");
  });

  test("create → list → start (from the branch) → done, recorded as source cli", async () => {
    const created = await spider(
      "task",
      "create",
      "--project",
      "spi",
      "--title",
      "Ship the CLI",
      "--description",
      "v1",
      "--priority",
      "2",
      "--json",
    );
    expect(created.code).toBe(0);
    const task = created.json();
    expect(task).toMatchObject({
      key: "SPI-1",
      title: "Ship the CLI",
      priority: 2,
      status: { category: "todo" },
    });
    expect(
      (
        await spider(
          "task",
          "create",
          "--project",
          "SPI",
          "--title",
          "Other",
          "--assign",
          "me",
        )
      ).code,
    ).toBe(0);

    const mine = await spider("task", "list", "--mine", "--json");
    expect((mine.json().items as { key: string }[]).map((t) => t.key)).toEqual([
      "SPI-2",
    ]);
    const backlog = await spider(
      "task",
      "list",
      "--project",
      "SPI",
      "--status",
      "todo",
      "--limit",
      "1",
      "--json",
    );
    expect((backlog.json().items as unknown[]).length).toBe(1);

    // No key: the CLI takes it from the branch name.
    Bun.spawnSync({
      cmd: ["git", "init", "-q", "-b", "spi-1-ship-cli"],
      cwd: repo,
    });
    const started = await spider("task", "start", "--json");
    expect(started.code).toBe(0);
    expect(started.json()).toMatchObject({
      key: "SPI-1",
      status: { category: "in_progress" },
      assigneeIds: [agentId],
      assignees: ["cli-bot"],
    });

    const done = await spider("task", "done", "SPI-1", "--json");
    expect(done.json()).toMatchObject({
      key: "SPI-1",
      status: { category: "done" },
    });
    expect(done.json().completedAt).not.toBeNull();

    const log = await db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.entityId, task.id as string));
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(new Set(log.map((e) => e.source))).toEqual(new Set(["cli"]));

    expect((await spider("task", "view", "SPI-99")).code).toBe(3);
    expect(
      (await spider("task", "update", "SPI-1", "--assign", "nobody")).code,
    ).toBe(2);
  });
  test("login through the browser, use the saved key, then logout", async () => {
    // A fresh sign-in for the person approving in the "browser".
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        email: ownerEmail,
        callbackURL: `${env.WEB_ORIGIN}/`,
      }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (
      await app.request(link.pathname + link.search, { redirect: "manual" })
    ).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const configDir = mkdtempSync(join(tmpdir(), "spider-config-"));
    const loginEnv = {
      SPIDER_API_URL: env.API_ORIGIN,
      SPIDER_CONFIG_DIR: configDir,
    };
    const as = async (
      argv: string[],
      extra: Partial<Parameters<typeof run>[1]> = {},
    ) => {
      let stdout = "";
      let stderr = "";
      const code = await run(argv, {
        env: loginEnv,
        fetch: (input, init) => app.request(input, init),
        stdout: { write: (s: string) => (stdout += s) },
        stderr: { write: (s: string) => (stderr += s) },
        cwd: repo,
        ...extra,
      });
      return { code, stdout, stderr };
    };

    let opened = "";
    let approved = false;
    const login = await as(["login", "--name", "Test Box", "--json"], {
      openUrl: (url) => (opened = url),
      // The first wait is when the person approves in the browser.
      sleep: async () => {
        if (approved) return;
        const userCode = new URL(opened).searchParams.get("code") ?? "";
        const res = await app.request(`/v1/device/${userCode}/approve`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ orgSlug: slug }),
        });
        expect(res.status).toBe(204);
        approved = true;
        await db
          .update(schema.deviceCodes)
          .set({ lastPolledAt: null })
          .where(eq(schema.deviceCodes.userCode, userCode));
      },
    });
    expect(login.code).toBe(0);
    expect(login.stderr).toContain("confirm the code");
    expect(JSON.parse(login.stdout)).toMatchObject({
      actor: { name: "spider CLI · Test Box" },
      organization: { slug },
    });

    const file = join(configDir, "credentials.json");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");

    const who = await as(["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      actor: { handle: "cli-test-box" },
    });

    const store = JSON.parse(readFileSync(file, "utf8")) as Store;
    expect(store.default).toEqual({
      server: "local",
      org: slug,
      agent: "cli-test-box",
    });
    const saved =
      store.servers.local?.orgs[slug]?.agents["cli-test-box"]?.token ?? "";
    expect(saved).toStartWith("spt_");
    expect((await as(["logout"])).stdout).toBe("Signed out @cli-test-box\n");
    expect(existsSync(file)).toBe(false);
    expect(
      (
        await app.request("/v1/whoami", {
          headers: { Authorization: `Bearer ${saved}` },
        })
      ).status,
    ).toBe(401);
    expect((await as(["whoami"])).code).toBe(4);
    rmSync(configDir, { recursive: true, force: true });
  });
  test("accept-invite saves agents per server and org; --as switches between them", async () => {
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        email: ownerEmail,
        callbackURL: `${env.WEB_ORIGIN}/`,
      }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (
      await app.request(link.pathname + link.search, { redirect: "manual" })
    ).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const invite = async () => {
      const res = await app.request(`/v1/orgs/${slug}/agent-invites`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ projectKeys: ["SPI"] }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { invite: { code: string } }).invite.code;
    };

    const configDir = mkdtempSync(join(tmpdir(), "spider-config-"));
    const as = async (argv: string[], extra: Record<string, string> = {}) => {
      let stdout = "";
      let stderr = "";
      const code = await run(argv, {
        env: { SPIDER_CONFIG_DIR: configDir, ...extra },
        fetch: (input, init) => app.request(input, init),
        stdout: { write: (s: string) => (stdout += s) },
        stderr: { write: (s: string) => (stderr += s) },
        cwd: repo,
      });
      return { code, stdout, stderr };
    };

    // A bare code goes to --server; the link's web host (localhost:5173) maps to the local API.
    const first = await as([
      "accept-invite",
      (await invite()).toLowerCase(),
      "--server",
      "local",
      "--name",
      "Reviewer",
      "--json",
    ]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      agent: `local/${slug}/reviewer`,
      actor: { handle: "reviewer", name: "Reviewer" },
      organization: { slug },
      projects: [{ key: "SPI", name: "Spider" }],
    });
    const second = await as([
      "accept-invite",
      `${env.WEB_ORIGIN}/agent-invite/${await invite()}`,
      "--name",
      "Writer",
      "--handle",
      "writer",
      "--description",
      "Writes docs",
    ]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Saved as local/${slug}/writer.`);
    expect(second.stdout).toContain("spider claude writer");
    for (const out of [first, second])
      expect(out.stdout + out.stderr).not.toContain("spt_");

    // A taken handle is a conflict (exit 2) and leaves the code usable.
    const code = await invite();
    expect(
      (
        await as([
          "accept-invite",
          code,
          "--server",
          "local",
          "--handle",
          "writer",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await as([
          "accept-invite",
          code,
          "--server",
          "local",
          "--handle",
          "editor",
          "--default",
        ])
      ).code,
    ).toBe(0);

    const file = join(configDir, "credentials.json");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    const store = JSON.parse(readFileSync(file, "utf8")) as Store;
    expect(store.default).toEqual({
      server: "local",
      org: slug,
      agent: "editor",
    });
    expect(Object.keys(store.servers.local?.orgs[slug]?.agents ?? {})).toEqual([
      "reviewer",
      "writer",
      "editor",
    ]);
    expect(store.servers.local?.orgs[slug]?.agents.reviewer).toMatchObject({
      source: "invite",
      projects: [{ key: "SPI" }],
    });

    const handleOf = async (
      argv: string[],
      extra: Record<string, string> = {},
    ) =>
      JSON.parse((await as([...argv, "--json"], extra)).stdout) as {
        actor: { handle: string };
        agent: string | null;
      };
    expect(await handleOf(["whoami"])).toMatchObject({
      actor: { handle: "editor" },
      agent: `local/${slug}/editor`,
    });
    expect((await handleOf(["whoami", "--as", "reviewer"])).actor.handle).toBe(
      "reviewer",
    );
    expect(
      (await handleOf(["--as", `${slug}/writer`, "whoami"])).actor.handle,
    ).toBe("writer");
    expect(
      (await handleOf(["whoami"], { SPIDER_AGENT: "writer" })).actor.handle,
    ).toBe("writer");
    expect(
      await handleOf(["whoami"], {
        SPIDER_TOKEN: token,
        SPIDER_API_URL: env.API_ORIGIN,
      }),
    ).toMatchObject({
      actor: { handle: "cli-bot" },
      agent: null,
    });

    // Each got a Claude Code agent in the private plugin; --claude deletes it with the agent.
    const writerAgent = join(
      configDir,
      "claude-plugin",
      "spider-agents",
      "agents",
      "local",
      slug,
      "writer.md",
    );
    expect(readFileSync(writerAgent, "utf8")).toContain(
      `spider-agent: local/${slug}/writer`,
    );
    const removed = await as([
      "agents",
      "remove",
      "writer",
      "--revoke",
      "--claude",
    ]);
    expect(removed.stdout).toBe(
      `Removed local/${slug}/writer and revoked its key\nDeleted Claude Code agent ${writerAgent}\n`,
    );
    const writerKey =
      store.servers.local?.orgs[slug]?.agents.writer?.token ?? "";
    expect(
      (
        await app.request("/v1/whoami", {
          headers: { Authorization: `Bearer ${writerKey}` },
        })
      ).status,
    ).toBe(401);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("comments, inbox and the Claude Code channel", async () => {
    // The owner, in the browser, mentions the agent (handle "cli-bot") on SPI-1.
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        email: ownerEmail,
        callbackURL: `${env.WEB_ORIGIN}/`,
      }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (
      await app.request(link.pathname + link.search, { redirect: "manual" })
    ).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const ownerComment = (cookieBody: string) =>
      app.request(`/v1/orgs/${slug}/tasks/SPI-1/comments`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ body: cookieBody }),
      });

    // CLI: comment, then the inbox shows nothing for the commenter itself.
    const commented = await spider(
      "comment",
      "SPI-1",
      "Picked",
      "this",
      "up",
      "--json",
    );
    expect(commented.code).toBe(0);
    expect(commented.json()).toMatchObject({
      taskKey: "SPI-1",
      body: "Picked this up",
    });
    expect((await spider("comment", "--json")).code).toBe(2);

    expect((await ownerComment("@cli-bot did the CLI ship?")).status).toBe(201);
    const inbox = await spider("inbox", "--json", "--mark-read");
    const items = inbox.json().items as {
      kind: string;
      task: { key: string };
    }[];
    expect(items.map((i) => [i.kind, i.task.key])).toContainEqual([
      "mention",
      "SPI-1",
    ]);
    expect((await spider("inbox", "--json")).json()).toEqual({ items: [] });
    expect((await spider("comments", "SPI-1")).stdout).toContain(
      "did the CLI ship?",
    );

    // Channel: a new mention is pushed into the "session"; the session replies with the tool.
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createChannel } = await import("./channel");
    const { createClient } = await import("@repo/sdk");
    const channel = createChannel({
      client: createClient({
        baseUrl: env.API_ORIGIN,
        token,
        source: "cli",
        fetch: (i, init) => app.request(i, init),
      }),
      org: slug,
      handle: "cli-bot",
      waitSeconds: 2,
      retryMs: 100,
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const session = new Client({ name: "claude-code-test", version: "0" });
    const pushed: { content: string; meta: Record<string, string> }[] = [];
    session.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel")
        pushed.push(n.params as (typeof pushed)[number]);
    };
    await channel.server.connect(serverSide);
    await session.connect(clientSide);
    expect(session.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel",
    );
    expect(session.getInstructions()).toContain("@cli-bot");

    const stop = new AbortController();
    const pumping = channel.pump(stop.signal);
    await ownerComment("@cli-bot please also check the docs");
    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(100);
    expect(pushed[0]?.meta).toMatchObject({
      task: "SPI-1",
      kind: "mention",
      from_type: "human",
    });
    expect(pushed[0]?.content).toContain("please also check the docs");

    const reply = await session.callTool({
      name: "reply",
      arguments: {
        task: "SPI-1",
        text: "Docs checked",
        reply_to: pushed[0]?.meta.comment_id,
      },
    });
    expect(reply.isError).toBeFalsy();
    const thread = await app.request(`/v1/orgs/${slug}/tasks/SPI-1/comments`, {
      headers: { Cookie: cookie },
    });
    const comments = (
      (await thread.json()) as {
        items: { body: string; parentId: string | null }[];
      }
    ).items;
    expect(comments.at(-1)).toMatchObject({
      body: "Docs checked",
      parentId: pushed[0]?.meta.comment_id,
    });

    // Project rules (ST-111): the owner sets them; the channel pushes the change, the CLI shows them.
    const asOwner = (method: string, path: string, body: unknown) =>
      app.request(`/v1/orgs/${slug}${path}`, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const rulesDoc = (await (
      await asOwner("POST", "/documents", {
        title: "Rules",
        project: "SPI",
        content: "Done means merged.",
      })
    ).json()) as { id: string };
    expect(
      (
        await asOwner("PATCH", "/projects/SPI", {
          rulesDocumentId: rulesDoc.id,
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 50 && pushed.length < 2; i++) await Bun.sleep(100);
    expect(pushed[1]?.meta).toMatchObject({
      kind: "rules",
      project: "SPI",
      document_id: rulesDoc.id,
    });
    expect(pushed[1]?.meta).not.toHaveProperty("task");
    expect(pushed[1]?.content).toContain(
      'changed the rules of project SPI: "Rules"',
    );
    // The channel marks the rules item read too (ST-128: `upTo` covers only the kinds named).
    let unread: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      unread = (await spider("inbox", "--json")).json().items as unknown[];
      if (unread.length === 0) break;
      await Bun.sleep(100);
    }
    expect(unread).toEqual([]);

    const view = await spider("project", "view", "SPI");
    expect(view.stdout).toContain(
      `Rules for agents: Rules (${rulesDoc.id}, v1)`,
    );
    expect(view.stdout).toContain("Done means merged.");
    // A rules document that can't be read (deleted meanwhile) shows as no rules (ST-128).
    const rulesGone = await spiderVia(
      (input, init) =>
        (init.method ?? "GET") === "GET" &&
        new URL(input).pathname.endsWith(`/documents/${rulesDoc.id}`)
          ? Response.json(
              { error: { code: "not_found", message: "Document not found" } },
              { status: 404 },
            )
          : app.request(input, init),
      ["project", "view", "SPI", "--json"],
    );
    expect(rulesGone.code).toBe(0);
    expect(rulesGone.json()).toMatchObject({
      key: "SPI",
      rulesDocumentId: rulesDoc.id,
      rules: null,
    });
    // An owner's agent may clear them.
    expect(
      (
        await spider("project", "update", "SPI", "--rules", "", "--json")
      ).json(),
    ).toMatchObject({ rulesDocumentId: null });
    // Status automation from pull requests (ST-85).
    expect(
      (
        await spider(
          "project",
          "update",
          "SPI",
          "--on-closed",
          "Canceled",
          "--on-draft",
          "none",
          "--json",
        )
      ).json(),
    ).toMatchObject({
      gitAutomation: {
        enabled: true,
        draft: null,
        opened: "in_review",
        merged: "done",
        closed: "canceled",
      },
    });
    expect((await spider("project", "view", "SPI")).stdout).toContain(
      "Status automation from pull requests: draft → no change, opened → in_review, merged → done, closed → canceled",
    );
    expect(
      (
        await spider(
          "project",
          "update",
          "SPI",
          "--automation",
          "off",
          "--json",
        )
      ).json(),
    ).toMatchObject({ gitAutomation: { enabled: false } });
    expect(
      (
        await spider(
          "project",
          "update",
          "SPI",
          "--automation",
          "defaults",
          "--json",
        )
      ).json(),
    ).toMatchObject({
      gitAutomation: {
        enabled: true,
        draft: "in_progress",
        opened: "in_review",
        merged: "done",
        closed: null,
      },
    });
    expect(
      (await spider("project", "update", "SPI", "--on-merged", "shipped")).code,
    ).toBe(2);
    expect(
      (
        await spider(
          "project",
          "update",
          "SPI",
          "--automation",
          "defaults",
          "--on-merged",
          "done",
        )
      ).code,
    ).toBe(2);
    expect(
      (await asOwner("DELETE", `/documents/${rulesDoc.id}`, {})).status,
    ).toBeLessThan(300);

    // Document comments (ST-118): a mention on a document is pushed with its document_id; the reply goes there.
    const spec = (await (
      await asOwner("POST", "/documents", {
        title: "Spec",
        project: "SPI",
        content: "Plan",
      })
    ).json()) as { id: string };
    const asked = (await (
      await asOwner("POST", `/documents/${spec.id}/comments`, {
        body: "@cli-bot review this?",
      })
    ).json()) as { id: string };
    for (let i = 0; i < 50 && pushed.length < 3; i++) await Bun.sleep(100);
    expect(pushed[2]?.meta).toMatchObject({
      kind: "document_mention",
      project: "SPI",
      document_id: spec.id,
      comment_id: asked.id,
    });
    expect(pushed[2]?.meta).not.toHaveProperty("task");
    expect(pushed[2]?.content).toContain(
      'mentioned you in a comment on document "Spec"',
    );
    const docReply = await session.callTool({
      name: "reply",
      arguments: { document_id: spec.id, text: "Reviewed", reply_to: asked.id },
    });
    expect(docReply.isError).toBeFalsy();
    const docThread = await session.callTool({
      name: "get_comments",
      arguments: { document_id: spec.id },
    });
    expect(JSON.stringify(docThread.content)).toContain("Reviewed");
    const both = await session.callTool({
      name: "reply",
      arguments: { task: "SPI-1", document_id: spec.id, text: "?" },
    });
    expect(both).toMatchObject({
      isError: true,
      content: [{ text: "Pass either task or document_id" }],
    });
    expect(
      (await asOwner("DELETE", `/documents/${spec.id}`, {})).status,
    ).toBeLessThan(300);

    stop.abort();
    await pumping;
    await session.close();

    // `spider inbox --mark-read` marks the document items it listed too (ST-128).
    const later = (await (
      await asOwner("POST", "/documents", {
        title: "Later",
        project: "SPI",
        content: "Plan",
      })
    ).json()) as { id: string };
    expect(
      (
        await asOwner("POST", `/documents/${later.id}/comments`, {
          body: "@cli-bot one more?",
        })
      ).status,
    ).toBe(201);
    const listed = (await spider("inbox", "--json", "--mark-read")).json()
      .items as { kind: string }[];
    expect(listed.map((i) => i.kind)).toContain("document_mention");
    expect((await spider("inbox", "--json")).json()).toEqual({ items: [] });
    expect(
      (await asOwner("DELETE", `/documents/${later.id}`, {})).status,
    ).toBeLessThan(300);
    // Stopping the channel waits out its long poll, so this test runs close to the default 5 s.
  }, 15_000);
  test("tags: list, set on create and update, unknown names fail with the list", async () => {
    // Agents (members) can create tags through the API; the CLI only reads and assigns them.
    const res = await app.request(`/v1/orgs/${slug}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "cli" }),
    });
    expect(res.status).toBe(201);
    expect((await spider("tags")).stdout).toBe("cli\n");

    const created = await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "Tagged",
      "--tag",
      "#CLI",
      "--json",
    );
    expect(created.json()).toMatchObject({ tags: ["cli"] });
    const key = created.json().key as string;
    expect((await spider("task", "view", key)).stdout).toContain("Tags: cli");
    expect(
      (await spider("task", "update", key, "--tag", "nope")).stderr,
    ).toContain("Existing tags: cli");
    // An empty --tag clears the tags, like --description "".

    await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "Tagged urgent",
      "--tag",
      "cli",
      "--priority",
      "1",
    );
    const listed = await spider(
      "task",
      "list",
      "--project",
      "SPI",
      "--tag",
      "CLI",
      "--priority",
      "1,high",
      "--json",
    );
    expect(
      (listed.json().items as { title: string }[]).map((t) => t.title),
    ).toEqual(["Tagged urgent"]);
    expect(
      (
        await spider(
          "task",
          "list",
          "--project",
          "SPI",
          "--tag",
          "cli",
          "--priority",
          "urgent",
        )
      ).stdout,
    ).toContain("Tagged urgent");
    expect(
      (
        await spider(
          "task",
          "list",
          "--project",
          "SPI",
          "--tag",
          "cli",
          "--priority",
          "4",
        )
      ).stdout,
    ).toBe("No tasks\n");
    const unknown = await spider(
      "task",
      "list",
      "--project",
      "SPI",
      "--tag",
      "nope",
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Existing tags: cli");
    expect(
      (await spider("task", "update", key, "--tag", "", "--json")).json(),
    ).toMatchObject({ tags: [] });
  });

  test("a deactivated assignee is shown by handle, not id", async () => {
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    if (!org) throw new Error("no org");
    const [gone] = await db
      .insert(schema.actors)
      .values({
        orgId: org.id,
        type: "agent",
        name: "Gone",
        handle: "gone",
        role: "member",
      })
      .returning();
    if (!gone) throw new Error("insert failed");
    const created = await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "Orphaned",
      "--assign",
      "gone",
      "--json",
    );
    const key = created.json().key as string;
    await db
      .update(schema.actors)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.actors.id, gone.id));

    expect((await spider("task", "view", key)).stdout).toContain(
      "@gone (deactivated)",
    );
    expect((await spider("task", "view", key, "--json")).json()).toMatchObject({
      assignees: ["gone (deactivated)"],
    });
    expect((await spider("task", "list", "--project", "SPI")).stdout).toContain(
      "@gone (deactivated)",
    );
    expect(
      (await spider("task", "update", key, "--assign", "gone")).code,
    ).not.toBe(0);
    // Orphaned assignments can be found by the deactivated handle (ST-65).
    const orphaned = await spider(
      "task",
      "list",
      "--project",
      "SPI",
      "--assignee",
      "@gone",
      "--json",
    );
    expect(
      (orphaned.json().items as { key: string }[]).map((t) => t.key),
    ).toEqual([key]);
  });

  test("--any-tag, and the filters still hold against a server that ignores them", async () => {
    await app.request(`/v1/orgs/${slug}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "ops" }),
    });
    for (const [title, tags] of [
      ["Has cli", "cli"],
      ["Has ops", "ops"],
      ["Has both", "cli,ops"],
    ] as const) {
      await spider(
        "task",
        "create",
        "--project",
        "SPI",
        "--title",
        title,
        "--tag",
        tags,
        "--priority",
        "3",
      );
    }
    // The agent's owner: part of "mine", unlike "me".
    await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "For the owner",
      "--assign",
      `cli-owner-${stamp}`,
      "--priority",
      "3",
    );
    const titles = async (via: typeof spider, ...args: string[]) => {
      const result = await via(
        "task",
        "list",
        "--project",
        "SPI",
        "--limit",
        "500",
        "--json",
        ...args,
      );
      expect(result.code).toBe(0);
      return (result.json().items as { title: string }[])
        .map((t) => t.title)
        .sort();
    };
    // An API from before ST-50 knows no filters: it drops the query and returns every task.
    const old = (...argv: string[]) =>
      spiderVia(
        (input, init) => app.request(input.split("?")[0] ?? input, init),
        argv,
      );
    const everything = await titles(spider);
    expect(everything.length).toBeGreaterThan(3);

    for (const via of [spider, old]) {
      expect(await titles(via, "--tag", "cli,ops")).toEqual(["Has both"]);
      expect(
        await titles(via, "--tag", "cli,ops", "--any-tag", "--priority", "3"),
      ).toEqual(["Has both", "Has cli", "Has ops"]);
      expect(await titles(via, "--tag", "ops", "--any-tag")).toEqual([
        "Has both",
        "Has ops",
      ]);
      expect(
        await titles(
          via,
          "--assignee",
          "@none",
          "--priority",
          "medium",
          "--status",
          "todo",
        ),
      ).toEqual(["Has both", "Has cli", "Has ops"]);
      expect(await titles(via, "--mine", "--priority", "3")).toEqual([]);
      expect(
        await titles(via, "--assignee", "mine", "--priority", "3"),
      ).toEqual(["For the owner"]);
      expect(
        await titles(via, "--assignee", "@Mine,none", "--priority", "3"),
      ).toEqual(["For the owner", "Has both", "Has cli", "Has ops"]);
      expect(await titles(via)).toEqual(everything);
    }
  });

  test("task update with several keys, or by filter with a preview until --yes (ST-106)", async () => {
    const parent = (
      await spider(
        "task",
        "create",
        "--project",
        "SPI",
        "--title",
        "Bulk parent",
        "--json",
      )
    ).json().key as string;
    const kids: string[] = [];
    for (const title of ["Bulk 1", "Bulk 2", "Bulk 3"]) {
      kids.push(
        (
          await spider(
            "task",
            "create",
            "--project",
            "SPI",
            "--title",
            title,
            "--parent",
            parent,
            "--json",
          )
        ).json().key as string,
      );
    }
    const [k1 = "", k2 = "", k3 = ""] = kids;
    const statusOf = async (key: string) =>
      (
        (await spider("task", "view", key, "--json")).json().status as {
          name: string;
        }
      ).name;

    // Several keys: --status sets, as for one key; a missing task fails alone, with exit code 1.
    const byKeys = await spider(
      "task",
      "update",
      k1,
      k2,
      "SPI-999",
      "--status",
      "In Review",
      "--assign",
      "me",
    );
    expect(byKeys.code).toBe(1);
    expect(byKeys.stdout).toContain(
      `${k1.padEnd(7)}  changed  In Review  Bulk 1`,
    );
    expect(byKeys.stdout).toContain("SPI-999  failed   Task SPI-999 not found");
    expect(byKeys.stdout).toEndWith("2 changed, 0 unchanged, 1 failed\n");
    expect(await statusOf(k2)).toBe("In Review");
    const again = await spider(
      "task",
      "update",
      k1,
      k2,
      "--set-status",
      "in_review",
      "--json",
    );
    expect(again.code).toBe(0);
    expect(again.json()).toMatchObject({
      dryRun: false,
      summary: { changed: 0, unchanged: 2, failed: 0 },
      results: [
        {
          key: k1,
          outcome: "unchanged",
          task: { status: { name: "In Review" }, assignees: ["cli-bot"] },
        },
        { key: k2 },
      ],
    });

    // By filter: --status filters and --set-status sets; without --yes it only previews.
    const filter = [
      "task",
      "update",
      "--project",
      "spi",
      "--parent",
      parent,
      "--status",
      "in_review",
      "--set-status",
      "Backlog",
    ];
    const preview = await spider(...filter);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain(`${k1}  would change  Backlog  Bulk 1`);
    expect(preview.stdout).toEndWith(
      "Dry run: 2 would change, 0 unchanged, 0 failed; nothing was changed. Run again with --yes to apply.\n",
    );
    expect(await statusOf(k1)).toBe("In Review");
    const applied = await spider(...filter, "--yes", "--json");
    expect(applied.json()).toMatchObject({
      dryRun: false,
      summary: { changed: 2 },
      results: [{ key: k1 }, { key: k2 }],
    });
    expect(await statusOf(k1)).toBe("Backlog");
    expect(await statusOf(k3)).toBe("Todo");
    expect((await spider(...filter, "--yes")).stdout).toBe(
      "No matching tasks\n",
    );

    // --dry-run previews several keys too.
    const dry = await spider(
      "task",
      "update",
      k3,
      k1,
      "--status",
      "Done",
      "--dry-run",
      "--json",
    );
    expect(dry.json()).toMatchObject({ dryRun: true, summary: { changed: 2 } });
    expect(await statusOf(k3)).toBe("Todo");

    const usage = async (...argv: string[]) => {
      const result = await spider(...argv);
      expect(result.code).toBe(2);
      return result.stderr;
    };
    expect(
      await usage(
        "task",
        "update",
        k1,
        "--project",
        "SPI",
        "--set-status",
        "Done",
      ),
    ).toContain("not both");
    expect(
      await usage("task", "update", "--project", "SPI", "--assign", "me"),
    ).toContain("--set-assign");
    expect(
      await usage("task", "update", "--project", "SPI", "--status", "todo"),
    ).toContain("--set-status");
    expect(await usage("task", "update", k1, k2, "--title", "Same")).toContain(
      "one task at a time",
    );
    expect(
      await usage(
        "task",
        "update",
        k1,
        "--status",
        "Done",
        "--set-status",
        "Todo",
      ),
    ).toContain("not both");
    expect(await usage("task", "update", k1, "--assignee", "me")).toContain(
      "--project",
    );
    expect(
      await usage(
        "task",
        "update",
        "--project",
        "SPI",
        "--status",
        "Nope",
        "--set-status",
        "Done",
      ),
    ).toContain('Unknown status "Nope"');
  });

  test('dates: --start and --target on create and update, cleared with "", shown on list and view; list --overdue (ST-91)', async () => {
    const created = await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "Dated",
      "--start",
      "2020-01-01",
      "--target",
      "2020-01-31",
      "--json",
    );
    expect(created.json()).toMatchObject({
      startDate: "2020-01-01",
      targetDate: "2020-01-31",
    });
    const key = created.json().key as string;
    const view = await spider("task", "view", key);
    expect(view.stdout).toContain(
      "Start: 2020-01-01 · Target: 2020-01-31 (overdue)",
    );
    const list = await spider("task", "list", "--project", "SPI", "--overdue");
    expect(list.code).toBe(0);
    expect(list.stdout.trim().split("\n")).toEqual([
      expect.stringMatching(
        new RegExp(`^${key}\\s.*Dated  due 2020-01-31 \\(overdue\\)`),
      ),
    ]);

    const usage = async (...argv: string[]) => {
      const result = await spider(...argv);
      expect(result.code).toBe(2);
      return result.stderr;
    };
    expect(
      await usage("task", "update", key, "--target", "31/01/2020"),
    ).toContain('Invalid date "31/01/2020" in --target');
    expect(
      await usage("task", "update", key, "--start", "2020-02-15"),
    ).toContain("on or before the target date");
    expect(
      await usage("task", "update", key, "--overdue", "--status", "Done"),
    ).toContain("--project");
    expect(
      await usage(
        "task",
        "update",
        "--project",
        "SPI",
        "--target",
        "2020-01-01",
      ),
    ).toContain("--set-target");

    const cleared = await spider(
      "task",
      "update",
      key,
      "--start",
      "",
      "--target",
      "2999-01-01",
      "--json",
    );
    expect(cleared.json()).toMatchObject({
      startDate: null,
      targetDate: "2999-01-01",
    });
    expect(
      (
        await spider("task", "list", "--project", "SPI", "--overdue", "--json")
      ).json(),
    ).toEqual({ items: [] });

    // Several keys and filter mode take --set-start / --set-target too.
    const late = await spider(
      "task",
      "update",
      key,
      "--set-target",
      "2020-03-01",
      "--dry-run",
      "--json",
    );
    expect(late.json()).toMatchObject({
      dryRun: true,
      results: [{ key, task: { targetDate: "2020-03-01" } }],
    });
    await spider("task", "update", key, "--target", "2020-03-01");
    const byFilter = await spider(
      "task",
      "update",
      "--project",
      "SPI",
      "--overdue",
      "--set-target",
      "",
      "--yes",
      "--json",
    );
    expect(byFilter.json()).toMatchObject({
      summary: { changed: 1 },
      results: [{ key, task: { targetDate: null } }],
    });
  });

  test("sub-tasks: --parent on create, shown by view, cleared with an empty --parent", async () => {
    const child = await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "Child",
      "--parent",
      "spi-1",
      "--json",
    );
    expect(child.json()).toMatchObject({ parentKey: "SPI-1" });
    const key = child.json().key as string;
    const parent = await spider("task", "view", "SPI-1", "--json");
    expect(parent.json().url).toBe(`${env.WEB_ORIGIN}/${slug}/tasks/SPI-1`);
    expect(
      (parent.json().subtasks as { key: string }[]).map((t) => t.key),
    ).toContain(key);
    expect((await spider("task", "view", "SPI-1")).stdout).toContain(
      "Sub-tasks:",
    );
    expect((await spider("task", "view", key)).stdout).toContain(
      "Parent: SPI-1",
    );
    expect(
      (await spider("task", "update", key, "--parent", "", "--json")).json(),
    ).toMatchObject({ parentKey: null });
  });

  test("links: link, shown by view from both sides, unlink; bad kinds are usage errors", async () => {
    const other = (
      await spider(
        "task",
        "create",
        "--project",
        "SPI",
        "--title",
        "Waits on SPI-1",
        "--json",
      )
    ).json().key as string;
    expect((await spider("link", "SPI-1", "blocks", other)).stdout).toBe(
      `Linked: SPI-1 blocks ${other}\n`,
    );
    expect((await spider("task", "view", other)).stdout).toContain(
      "blocked by SPI-1",
    );
    expect(
      (await spider("task", "view", other, "--json")).json().relations,
    ).toEqual([
      { kind: "blocked_by", task: "SPI-1", title: expect.any(String) },
    ]);
    expect(
      (await spider("unlink", other, "Blocked-By", "SPI-1", "--json")).json(),
    ).toMatchObject({ linked: false });
    expect((await spider("link", "SPI-1", "depends", other)).code).toBe(2);
  });

  test("task duplicate: links, cancels and comments in one call; a repeat changes nothing; self is refused (ST-114)", async () => {
    const create = async (title: string) =>
      (
        await spider(
          "task",
          "create",
          "--project",
          "SPI",
          "--title",
          title,
          "--json",
        )
      ).json().key as string;
    const [copy, original] = [
      await create("Dup copy"),
      await create("Dup original"),
    ];
    const marked = await spider(
      "task",
      "duplicate",
      copy.toLowerCase(),
      "--of",
      original.toLowerCase(),
      "--comment",
      "Subset of it",
    );
    expect(marked.stdout).toStartWith(
      `Marked ${copy} as a duplicate of ${original}\n${copy}`,
    );
    expect(marked.stdout).toContain("Canceled");
    const view = (await spider("task", "view", copy, "--json")).json();
    expect(view).toMatchObject({
      status: { category: "canceled" },
      relations: [{ kind: "duplicates", task: original }],
    });
    const again = await spider(
      "task",
      "duplicate",
      copy,
      "--of",
      original,
      "--json",
    );
    expect(again.json()).toMatchObject({
      key: copy,
      updatedAt: view.updatedAt,
    });
    const comments = (await spider("comments", copy, "--json")).json()
      .items as { body: string }[];
    expect(comments.map((c) => c.body)).toEqual([
      `Duplicate of ${original}: Dup original\n\nSubset of it`,
    ]);
    const self = await spider("task", "duplicate", copy, "--of", copy);
    expect(self.code).toBe(2);
    expect(self.stderr).toContain("itself");
    expect((await spider("task", "duplicate", original)).code).toBe(2);
  });

  test("docs: create from a file and stdin, list by scope, view, edit from a base version", async () => {
    writeFileSync(join(repo, "spec.html"), "<h1>Spec</h1>");
    const spec = (
      await spider(
        "doc",
        "create",
        "--title",
        "Spec",
        "--project",
        "spi",
        "--file",
        "spec.html",
        "--json",
      )
    ).json();
    expect(spec).toMatchObject({
      projectKey: "SPI",
      taskKey: null,
      format: "html",
      content: "<h1>Spec</h1>",
      version: 1,
    });
    const id = spec.id as string;
    // The web page's address (ST-115).
    const url = `${env.WEB_ORIGIN}/${slug}/docs/${id}`;
    expect(spec.url).toBe(url);

    stdin = "# Notes";
    const notes = (
      await spider(
        "doc",
        "create",
        "--title",
        "Notes",
        "--task",
        "spi-1",
        "--file",
        "-",
        "--json",
      )
    ).json();
    expect(notes).toMatchObject({
      taskKey: "SPI-1",
      format: "md",
      content: "# Notes",
    });

    expect((await spider("doc", "list", "--task", "SPI-1")).stdout).toBe(
      `${notes.id as string}  SPI-1  v1  Notes\n`,
    );
    const all = (
      await spider("doc", "list", "--project", "SPI", "--json")
    ).json().items as { title: string }[];
    expect(all.map((d) => d.title).sort()).toEqual(["Notes", "Spec"]);

    stdin = "<h1>Spec v2</h1>";
    expect(
      (await spider("doc", "edit", id, "--file", "-", "--base-version", "1"))
        .stdout,
    ).toBe("Saved Spec as version 2\n");
    expect(
      (
        await spider(
          "doc",
          "edit",
          id,
          "--title",
          "Spec",
          "--base-version",
          "2",
        )
      ).stdout,
    ).toBe("No changes to Spec\n");

    // An edit based on version 1 must not overwrite version 2 (ST-21).
    stdin = "<h1>Stale</h1>";
    const stale = await spider(
      "doc",
      "edit",
      id,
      "--file",
      "-",
      "--base-version",
      "1",
      "--json",
    );
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain('"code":"conflict"');
    // Without a base version the edit is refused unless forced.
    expect((await spider("doc", "edit", id, "--title", "Spec 2")).code).toBe(2);
    expect(
      (
        await spider(
          "doc",
          "edit",
          id,
          "--title",
          "Spec",
          "--base-version",
          "x",
        )
      ).code,
    ).toBe(2);
    expect(
      (await spider("doc", "edit", id, "--title", "Spec", "--force")).stdout,
    ).toBe("No changes to Spec\n");
    expect((await spider("doc", "view", id)).stdout).toContain(
      "<h1>Spec v2</h1>",
    );
    expect((await spider("doc", "view", id)).stdout).toContain(`\n${url}\n`);
    expect(
      (await spider("doc", "view", id, "--rev", "1", "--json")).json(),
    ).toMatchObject({
      version: 1,
      currentVersion: 2,
      content: "<h1>Spec</h1>",
      url,
    });
    expect((await spider("doc", "edit", id)).code).toBe(2);
    expect(
      (await spider("doc", "view", "00000000-0000-7000-8000-000000000000"))
        .code,
    ).toBe(3);
  });

  test("docs: partial edits with --old/--new, --append and --section, no --force needed (ST-116)", async () => {
    stdin = "# Plan\n\nIntro.\n\n## Decisions\n\nOld.\n\n## Next\n\nLater.\n";
    const created = (
      await spider(
        "doc",
        "create",
        "--title",
        "Plan",
        "--project",
        "SPI",
        "--file",
        "-",
        "--json",
      )
    ).json();
    const id = created.id as string;

    expect(
      (await spider("doc", "edit", id, "--old", "Intro.", "--new", "Hello."))
        .stdout,
    ).toBe("Saved Plan as version 2\n");
    stdin = "New.\n";
    expect(
      (
        await spider(
          "doc",
          "edit",
          id,
          "--section",
          "## Decisions",
          "--file",
          "-",
          "--base-version",
          "2",
        )
      ).stdout,
    ).toBe("Saved Plan as version 3\n");
    const appended = (
      await spider("doc", "edit", id, "--append", "--text", "Done.", "--json")
    ).json();
    expect(appended).toMatchObject({
      version: 4,
      content:
        "# Plan\n\nHello.\n\n## Decisions\n\nNew.\n\n## Next\n\nLater.\nDone.",
    });
    expect(
      (await spider("doc", "edit", id, "--old", "Done.", "--new", "Done."))
        .stdout,
    ).toBe("No changes to Plan\n");

    const missing = await spider(
      "doc",
      "edit",
      id,
      "--old",
      "Intro.",
      "--new",
      "x",
      "--json",
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('"code":"conflict"');
    const stale = await spider(
      "doc",
      "edit",
      id,
      "--append",
      "--text",
      "late",
      "--base-version",
      "3",
    );
    expect(stale.code).toBe(2);
    expect(
      (await spider("doc", "edit", id, "--old", "e", "--new", "E")).code,
    ).toBe(2);

    // Usage errors: a partial edit is one of the three, with its text.
    expect((await spider("doc", "edit", id, "--old", "Hello.")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--append")).code).toBe(2);
    expect(
      (
        await spider(
          "doc",
          "edit",
          id,
          "--append",
          "--text",
          "a",
          "--section",
          "## Next",
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await spider(
          "doc",
          "edit",
          id,
          "--old",
          "a",
          "--new",
          "b",
          "--title",
          "T",
        )
      ).code,
    ).toBe(2);
    expect(
      (await spider("doc", "edit", id, "--text", "a", "--force")).code,
    ).toBe(2);
    expect((await spider("doc", "view", id, "--json")).json()).toMatchObject({
      version: 4,
      title: "Plan",
    });
  });

  test("docs: diff two versions, or a version against the current one (ST-117)", async () => {
    stdin = "# Diff\n\none\ntwo\n";
    const created = (
      await spider(
        "doc",
        "create",
        "--title",
        "Diff",
        "--project",
        "SPI",
        "--file",
        "-",
        "--json",
      )
    ).json();
    const id = created.id as string;
    await spider("doc", "edit", id, "--old", "two", "--new", "2");
    await spider("doc", "edit", id, "--append", "--text", "three");

    expect(
      (await spider("doc", "diff", id, "--from", "1", "--to", "2")).stdout,
    ).toBe(
      "--- Diff (v1)\n+++ Diff (v2)\n@@ -1,4 +1,4 @@\n # Diff\n \n one\n-two\n+2\n",
    );
    const json = (
      await spider("doc", "diff", id, "--from", "1", "--json")
    ).json();
    expect(json).toMatchObject({
      from: { version: 1 },
      to: { version: 3 },
      added: 2,
      removed: 1,
    });
    expect(
      (
        json.hunks as {
          lines: {
            kind: string;
            text: string;
            oldLine: number | null;
            newLine: number | null;
          }[];
        }[]
      )[0]?.lines.filter((l) => l.kind !== "context"),
    ).toEqual([
      { kind: "removed", text: "two", oldLine: 4, newLine: null },
      { kind: "added", text: "2", oldLine: null, newLine: 4 },
      { kind: "added", text: "three", oldLine: null, newLine: 5 },
    ]);
    expect((await spider("doc", "diff", id, "--from", "3")).stdout).toBe(
      "No changes in content between version 3 and 3\n",
    );
    // The append left no final newline: said under the diff (ST-129).
    expect(json).toMatchObject({
      trailingNewlineChanged: true,
      lineEndingsChanged: false,
    });
    expect(
      (await spider("doc", "diff", id, "--from", "2", "--to", "3")).stdout,
    ).toEndWith(
      "+three\n\\ The newline at the end differs between version 2 and 3\n",
    );

    expect((await spider("doc", "diff", id, "--from", "9")).code).toBe(3);
    expect((await spider("doc", "diff", id, "--from", "x")).code).toBe(2);
    expect((await spider("doc", "diff", id)).code).toBe(2);
  });

  test("docs: a rename updates [[links]]; backlinks of a document or a task; the graph (ST-101)", async () => {
    stdin = "# Target";
    const target = (
      await spider(
        "doc",
        "create",
        "--title",
        "Link target",
        "--project",
        "SPI",
        "--file",
        "-",
        "--json",
      )
    ).json();
    stdin = "See [[Link target|it]] for SPI-1.";
    const source = (
      await spider(
        "doc",
        "create",
        "--title",
        "Link source",
        "--file",
        "-",
        "--json",
      )
    ).json();
    const targetId = target.id as string;
    const sourceId = source.id as string;

    expect((await spider("doc", "backlinks", targetId)).stdout).toBe(
      `${sourceId}  org  v1  Link source\n`,
    );
    const mentions = (
      await spider("doc", "backlinks", "spi-1", "--json")
    ).json().items as { id: string; url: string }[];
    expect(mentions.map((d) => [d.id, d.url])).toEqual([
      [sourceId, `${env.WEB_ORIGIN}/${slug}/docs/${sourceId}`],
    ]);

    expect(
      (
        await spider(
          "doc",
          "edit",
          targetId,
          "--title",
          "Link target 2",
          "--base-version",
          "1",
        )
      ).stdout,
    ).toBe("Saved Link target 2 as version 2\nUpdated links in Link source\n");
    expect(
      (await spider("doc", "view", sourceId, "--json")).json(),
    ).toMatchObject({
      version: 2,
      content: "See [[Link target 2|it]] for SPI-1.",
    });

    const graph = (await spider("doc", "graph", "--json")).json() as {
      links: { from: string; to: unknown }[];
      tasks: { key: string; url: string }[];
    };
    expect(
      graph.links.filter((l) => l.from === sourceId).map((l) => l.to),
    ).toEqual([
      { type: "document", id: targetId },
      { type: "task", key: "SPI-1" },
    ]);
    expect(graph.tasks).toContainEqual(
      expect.objectContaining({
        key: "SPI-1",
        url: `${env.WEB_ORIGIN}/${slug}/tasks/SPI-1`,
      }),
    );
    expect((await spider("doc", "graph")).stdout).toContain(
      "Link source -> Link target 2\nLink source -> SPI-1",
    );
    expect(
      (await spider("doc", "backlinks", "00000000-0000-7000-8000-000000000000"))
        .code,
    ).toBe(3);
  });

  test("docs: move to the organization and back to a project", async () => {
    stdin = "# Movable";
    const created = (
      await spider(
        "doc",
        "create",
        "--title",
        "Movable",
        "--project",
        "SPI",
        "--file",
        "-",
        "--json",
      )
    ).json();
    const id = created.id as string;
    expect((await spider("doc", "move", id, "--org")).stdout).toBe(
      "Moved Movable to the organization\n",
    );
    expect(
      (await spider("doc", "move", id, "--project", "spi", "--json")).json(),
    ).toMatchObject({ id, projectKey: "SPI", version: 1 });
    expect((await spider("doc", "move", id)).code).toBe(2);
    expect(
      (await spider("doc", "move", id, "--org", "--project", "SPI")).code,
    ).toBe(2);
    expect((await spider("doc", "move", id, "--project", "NOPE")).code).toBe(3);
  });

  test("docs: publish a folder of 30 files with links; a rerun changes nothing; conflicts aren't overwritten (ST-119)", async () => {
    const dir = join(repo, "publish");
    mkdirSync(join(dir, "specs"), { recursive: true });
    mkdirSync(join(dir, ".obsidian"), { recursive: true });
    const names = Array.from({ length: 29 }, (_, i) => `Doc ${i + 1}`);
    writeFileSync(
      join(dir, "index.md"),
      `---\ntitle: Index\nproject: SPI\n---\n\n# Index\n\n${names.map((n) => `- [[${n}]]`).join("\n")}\n`,
    );
    names.forEach((name, i) =>
      writeFileSync(
        join(dir, "specs", `doc-${i + 1}.md`),
        `---\ntitle: ${name}\n---\n\nBack to [the index](../index.md). Next: [[Doc ${i + 2}]]. \`[[Doc 1]]\` stays.\n`,
      ),
    );
    writeFileSync(join(dir, ".obsidian", "workspace.md"), "not a document");
    writeFileSync(join(dir, "notes.txt"), "not a document");
    const file = (name: string) =>
      join(dir, name === "index" ? "index.md" : `specs/doc-${name}.md`);
    const read = (name: string) => readFileSync(file(name), "utf8");
    const snapshot = () =>
      ["index", ...names.map((_, i) => String(i + 1))].map(read);
    const idIn = (name: string) => /^id: (\S+)$/m.exec(read(name))?.[1] ?? "";
    const versionIn = (name: string) =>
      Number(/^version: (\d+)$/m.exec(read(name))?.[1]);
    type Report = {
      dryRun: boolean;
      results: {
        file: string;
        status: string;
        id: string | null;
        version: number | null;
        message?: string;
      }[];
      summary: Record<string, number>;
    };
    const publish = async (...extra: string[]) => {
      const res = await spider("doc", "publish", "publish", "--json", ...extra);
      return { code: res.code, report: res.json() as unknown as Report };
    };

    const before = snapshot();
    const plan = await publish("--dry-run");
    expect(plan.code).toBe(0);
    expect(plan.report).toMatchObject({
      dryRun: true,
      summary: {
        created: 30,
        updated: 0,
        unchanged: 0,
        conflict: 0,
        failed: 0,
      },
    });
    expect(snapshot()).toEqual(before);

    const first = await publish();
    expect(first.code).toBe(0);
    expect(first.report.summary).toEqual({
      created: 30,
      updated: 0,
      unchanged: 0,
      conflict: 0,
      failed: 0,
    });
    expect(first.report.results[0]).toMatchObject({
      file: "index.md",
      status: "created",
      id: idIn("index"),
      version: 2,
    });
    // Ids and versions are written back; the links in the files stay as written.
    expect(read("index")).toStartWith(
      `---\ntitle: Index\nproject: SPI\nid: ${idIn("index")}\nversion: 2\n---\n\n# Index\n\n- [[Doc 1]]\n`,
    );
    const index = (await spider("doc", "view", idIn("index"), "--json")).json();
    expect(index).toMatchObject({
      projectKey: "SPI",
      title: "Index",
      version: 2,
    });
    expect(index.content).toContain(
      `- [[doc:${idIn("1")}]]\n- [[doc:${idIn("2")}]]\n`,
    );
    expect(
      (await spider("doc", "view", idIn("1"), "--json")).json(),
    ).toMatchObject({
      projectKey: null,
      content: `Back to [[doc:${idIn("index")}|the index]]. Next: [[doc:${idIn("2")}]]. \`[[Doc 1]]\` stays.\n`,
    });
    // Doc 29's [[Doc 30]] isn't a file of the folder: published as written, in one version.
    expect(versionIn("29")).toBe(1);
    expect(
      (await spider("doc", "backlinks", idIn("1"), "--json")).json().items,
    ).toHaveLength(1);

    const published = snapshot();
    const rerun = await publish();
    expect(rerun.report.summary).toEqual({
      created: 0,
      updated: 0,
      unchanged: 30,
      conflict: 0,
      failed: 0,
    });
    expect(snapshot()).toEqual(published);

    // Someone edits Doc 2 in the tracker while the file changes too: a conflict, their edit stays.
    const doc2 = idIn("2");
    await spider("doc", "edit", doc2, "--append", "--text", "Their line.");
    writeFileSync(file("2"), `${read("2")}My line.\n`);
    writeFileSync(file("3"), `${read("3")}More.\n`);
    const mixed = await spider("doc", "publish", "publish");
    expect(mixed.code).toBe(1);
    expect(mixed.stdout).toContain(
      `conflict   specs/doc-2.md   Doc 2  (${doc2}, v3)\n  Changed in the tracker since version 2 (now 3)`,
    );
    expect(mixed.stdout).toContain("updated    specs/doc-3.md   Doc 3");
    expect(mixed.stdout).toEndWith(
      "0 created, 1 updated, 28 unchanged, 1 conflict, 0 failed\n",
    );
    const kept = (await spider("doc", "view", doc2, "--json")).json();
    expect(kept).toMatchObject({ version: 3 });
    expect(kept.content).toEndWith("Their line.");
    expect(versionIn("2")).toBe(2);
    expect(versionIn("3")).toBe(3);

    // A dry run plans without saving; after merging and setting the version, the file publishes.
    writeFileSync(file("4"), `${read("4")}Later.\n`);
    const dry = await publish("--dry-run");
    expect(
      dry.report.results
        .filter((r) => r.status !== "unchanged")
        .map((r) => [r.file, r.status]),
    ).toEqual([
      ["specs/doc-2.md", "conflict"],
      ["specs/doc-4.md", "updated"],
    ]);
    expect(
      (await spider("doc", "view", idIn("4"), "--json")).json(),
    ).toMatchObject({ version: 2 });
    writeFileSync(file("2"), read("2").replace("version: 2", "version: 3"));
    const merged = await publish();
    expect(merged.code).toBe(0);
    expect(merged.report.summary).toMatchObject({ updated: 2, conflict: 0 });
    expect(versionIn("2")).toBe(4);

    // A file that isn't UTF-8 (cp1251 here) fails and keeps its bytes; the others publish as usual.
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]);
    writeFileSync(join(dir, "legacy.md"), cp1251);
    const legacy = await spider("doc", "publish", "publish");
    expect(legacy.code).toBe(1);
    expect(legacy.stdout).toContain(
      "failed     legacy.md        legacy\n  Not UTF-8 text; not published, and the file wasn't changed",
    );
    expect(legacy.stdout).toEndWith(
      "0 created, 0 updated, 30 unchanged, 0 conflicts, 1 failed\n",
    );
    expect(new Uint8Array(readFileSync(join(dir, "legacy.md")))).toEqual(
      cp1251,
    );
    rmSync(join(dir, "legacy.md"));

    expect((await spider("doc", "publish", "missing")).code).toBe(2);
    writeFileSync(join(dir, "bad.md"), "---\nid: D31\n---\n");
    expect(
      (await spider("doc", "publish", "publish", "--json")).stderr,
    ).toContain('bad.md: id \\"D31\\" isn\'t a document id');
    rmSync(join(dir, "bad.md"));
  });

  test("projects: an agent acts with its owner's rights; refused when the owner is a member", async () => {
    const [ownerActor] = await db
      .select({ id: schema.actors.id })
      .from(schema.agents)
      .innerJoin(schema.actors, eq(schema.actors.id, schema.agents.ownerId))
      .where(eq(schema.agents.actorId, agentId));
    const ownerId = ownerActor?.id ?? "";
    await db
      .update(schema.actors)
      .set({ role: "member" })
      .where(eq(schema.actors.id, ownerId));
    try {
      const refused = await spider(
        "project",
        "create",
        "--key",
        "OPS",
        "--name",
        "Ops",
        "--json",
      );
      expect(refused.code).toBe(4);
      expect(JSON.parse(refused.stderr)).toEqual({
        error: {
          code: "forbidden",
          message: "Your role can't create projects",
        },
      });
    } finally {
      await db
        .update(schema.actors)
        .set({ role: "owner" })
        .where(eq(schema.actors.id, ownerId));
    }

    const created = await spider(
      "project",
      "create",
      "--key",
      "ops",
      "--name",
      "Ops",
      "--description",
      "Runbooks",
      "--json",
    );
    expect(created.code).toBe(0);
    expect(created.json()).toMatchObject({
      key: "OPS",
      name: "Ops",
      description: "Runbooks",
      archivedAt: null,
    });
    expect(
      (await spider("project", "create", "--key", "OPS", "--name", "Again"))
        .code,
    ).toBe(2);
    expect(
      (
        await spider(
          "task",
          "create",
          "--project",
          "OPS",
          "--title",
          "Rotate keys",
        )
      ).code,
    ).toBe(0);

    const view = await spider("project", "view", "ops", "--json");
    expect(view.json()).toMatchObject({ key: "OPS", archivedAt: null });
    const counts = (
      view.json().statuses as { name: string; taskCount: number }[]
    ).map((s) => [s.name, s.taskCount]);
    expect(counts).toEqual([
      ["Backlog", 0],
      ["Todo", 1],
      ["In Progress", 0],
      ["In Review", 0],
      ["Done", 0],
      ["Canceled", 0],
    ]);
    const human = (await spider("project", "view", "OPS")).stdout;
    expect(human).toStartWith("OPS  Ops\n");
    expect(human).toContain("\nTask workflow:\n");
    expect(human).toContain("  Todo         todo         1\n");
    expect(human).toContain(
      "\nRelease workflow:\n  Planned         todo         0\n",
    );
    expect(human).toEndWith("\nRunbooks\n");

    const updated = await spider(
      "project",
      "update",
      "OPS",
      "--name",
      "Operations",
      "--description",
      "",
      "--json",
    );
    expect(updated.json()).toMatchObject({
      key: "OPS",
      name: "Operations",
      description: null,
    });
    expect((await spider("project", "update", "OPS")).code).toBe(2);

    expect((await spider("project", "archive", "OPS")).stdout).toBe(
      "Archived OPS  Operations\n",
    );
    expect((await spider("projects")).stdout).toBe("SPI  Spider\n");
    expect((await spider("projects", "--archived")).stdout).toBe(
      "SPI  Spider\nOPS  Operations  (archived)\n",
    );
    expect(
      (await spider("project", "view", "OPS", "--json")).json().archivedAt,
    ).not.toBeNull();
    const late = await spider(
      "task",
      "create",
      "--project",
      "OPS",
      "--title",
      "Too late",
    );
    expect(late).toMatchObject({
      code: 2,
      stderr: "spider: Project OPS is archived\n",
    });

    const restored = await spider(
      "project",
      "archive",
      "OPS",
      "--undo",
      "--json",
    );
    expect(restored.json()).toMatchObject({ key: "OPS", archivedAt: null });
    expect((await spider("projects", "--json")).json().items).toMatchObject([
      { key: "SPI" },
      { key: "OPS" },
    ]);
    expect((await spider("project", "view", "NOPE")).code).toBe(3);

    // ST-40's "done when": then a doc in the agent's new project.
    stdin = "# Runbook";
    const doc = await spider(
      "doc",
      "create",
      "--title",
      "Runbook",
      "--project",
      "OPS",
      "--file",
      "-",
      "--json",
    );
    expect(doc.code).toBe(0);
    expect(doc.json()).toMatchObject({ projectKey: "OPS", title: "Runbook" });
  });

  test("project status: list, add, rename, recolor, reorder and delete statuses per kind (ST-90)", async () => {
    await spider("project", "create", "--key", "WFC", "--name", "Workflows");
    expect(
      (await spider("task", "create", "--project", "WFC", "--title", "In todo"))
        .code,
    ).toBe(0);
    const all = await spider("project", "status", "list", "WFC", "--json");
    expect((all.json().items as { kind: string }[]).map((s) => s.kind)).toEqual(
      [
        ...Array<string>(6).fill("task"),
        ...Array<string>(5).fill("release"),
        ...Array<string>(4).fill("milestone"),
      ],
    );
    expect(
      (await spider("project", "status", "WFC", "--kind", "milestone")).stdout,
    ).toBe(
      "Milestone workflow:\n  Planned         todo\n  Active          in_progress\n  Ready to close  in_review\n  Done            done\n",
    );

    const added = await spider(
      "project",
      "status",
      "add",
      "WFC",
      "QA",
      "--category",
      "in review",
      "--position",
      "3",
      "--json",
    );
    expect(added.code).toBe(0);
    const names = (json: Record<string, unknown>, kind: string) =>
      ((json.workflows as Record<string, { name: string }[]>)[kind] ?? []).map(
        (s) => s.name,
      );
    expect(names(added.json(), "task")).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "QA",
      "In Review",
      "Done",
      "Canceled",
    ]);
    const moved = await spider(
      "project",
      "status",
      "update",
      "WFC",
      "qa",
      "--name",
      "Testing",
      "--color",
      "#00ff00",
      "--position",
      "0",
      "--json",
    );
    expect(names(moved.json(), "task")[0]).toBe("Testing");
    const release = await spider(
      "project",
      "status",
      "update",
      "WFC",
      "On staging",
      "--kind",
      "release",
      "--name",
      "Staging",
    );
    expect(release.stdout).toStartWith(
      'Updated "On staging" in WFC\'s release workflow\nRelease workflow:\n  Planned ',
    );
    expect(release.stdout).toContain("\n  Staging         in_progress\n");

    const deleted = await spider(
      "project",
      "status",
      "delete",
      "WFC",
      "Todo",
      "--move-to",
      "backlog",
      "--json",
    );
    expect(deleted.json()).toMatchObject({
      movedTasks: 1,
      project: { key: "WFC" },
    });
    expect(
      (
        await spider(
          "task",
          "list",
          "--project",
          "WFC",
          "--status",
          "Backlog",
          "--json",
        )
      ).json().items,
    ).toMatchObject([{ title: "In todo" }]);
    const human = await spider(
      "project",
      "status",
      "delete",
      "WFC",
      "Staging",
      "--kind",
      "release",
      "--move-to",
      "Planned",
    );
    expect(human.stdout).toStartWith(
      'Deleted "Staging" from WFC\'s release workflow; 0 tasks moved to "Planned"\n',
    );

    // Refusals: the last done status, unknown names, kinds and categories, nothing to change.
    const lastDone = await spider(
      "project",
      "status",
      "delete",
      "WFC",
      "Done",
      "--move-to",
      "Backlog",
    );
    expect(lastDone).toMatchObject({
      code: 2,
      stderr: "spider: The task workflow needs at least one done status\n",
    });
    expect(
      (
        await spider(
          "project",
          "status",
          "update",
          "WFC",
          "Released",
          "--name",
          "X",
        )
      ).stderr,
    ).toContain('Unknown status "Released" in WFC');
    expect(
      (
        await spider(
          "project",
          "status",
          "add",
          "WFC",
          "X",
          "--category",
          "shipped",
        )
      ).code,
    ).toBe(2);
    expect(
      (await spider("project", "status", "list", "WFC", "--kind", "epic")).code,
    ).toBe(2);
    expect(
      (await spider("project", "status", "update", "WFC", "Backlog")).code,
    ).toBe(2);
    expect(
      (
        await spider(
          "project",
          "status",
          "add",
          "WFC",
          "backlog",
          "--category",
          "todo",
        )
      ).code,
    ).toBe(2);

    // Task lists filter by kind; the task is of kind task.
    expect(
      (
        await spider(
          "task",
          "list",
          "--project",
          "WFC",
          "--kind",
          "release",
          "--json",
        )
      ).json().items,
    ).toEqual([]);
    expect(
      (
        await spider(
          "task",
          "list",
          "--project",
          "WFC",
          "--kind",
          "task",
          "--json",
        )
      ).json().items,
    ).toMatchObject([{ kind: "task" }]);
    await spider("project", "archive", "WFC");
  });

  test("repos and apps: spider-tracker attached to ST, with apps web, api (staging, prod) and cli (semver, no environments) (ST-92)", async () => {
    expect(
      (
        await spider(
          "project",
          "create",
          "--key",
          "ST",
          "--name",
          "Spider Tracker",
        )
      ).code,
    ).toBe(0);
    const added = await spider(
      "repo",
      "add",
      "https://github.com/pipisasa/spider-tracker.git",
      "--project",
      "ST",
      "--json",
    );
    expect(added.code).toBe(0);
    expect(added.json()).toMatchObject({
      fullName: "pipisasa/spider-tracker",
      defaultBranch: "main",
      projects: ["ST"],
      apps: [],
    });
    const again = await spider(
      "repo",
      "add",
      "git@github.com:pipisasa/spider-tracker.git",
    );
    expect(again).toMatchObject({
      code: 2,
      stderr: "spider: Repo pipisasa/spider-tracker already exists\n",
    });
    expect((await spider("repo", "add", "https://gitlab.com/a/b")).code).toBe(
      2,
    );

    const web = await spider(
      "app",
      "add",
      "web",
      "--repo",
      "pipisasa/spider-tracker",
      "--path",
      "web/app",
      "--shared",
      "packages/core,packages/sdk",
      "--versioning",
      "date",
      "--env",
      "staging,prod",
      "--json",
    );
    expect(web.code).toBe(0);
    expect(web.json()).toMatchObject({
      repo: "pipisasa/spider-tracker",
      name: "web",
      path: "web/app",
      versioning: "date",
      environments: ["staging", "prod"],
    });
    expect(
      (
        await spider(
          "app",
          "add",
          "api",
          "--repo",
          "https://github.com/pipisasa/spider-tracker",
          "--path",
          "./backend/api/",
          "--shared",
          "packages/core",
          "--shared",
          "packages/db",
          "--versioning",
          "date",
          "--env",
          "staging",
          "--env",
          "prod",
        )
      ).stdout,
    ).toBe(
      "Added pipisasa/spider-tracker  api  backend/api (+ packages/core, packages/db)  date  staging → prod\n",
    );
    // Without --repo, the origin remote of the current folder.
    Bun.spawnSync({
      cmd: [
        "git",
        "remote",
        "add",
        "origin",
        "git@github.com:pipisasa/spider-tracker.git",
      ],
      cwd: repo,
    });
    const cli = await spider(
      "app",
      "add",
      "cli",
      "--path",
      "backend/cli",
      "--shared",
      "packages/core,packages/sdk",
      "--versioning",
      "semver",
      "--json",
    );
    expect(cli.json()).toMatchObject({
      name: "cli",
      versioning: "semver",
      environments: [],
    });
    expect(
      (await spider("app", "add", "x", "--path", "x", "--versioning", "calver"))
        .code,
    ).toBe(2);

    const view = (await spider("repo", "view", "--json")).json() as unknown as {
      projects: string[];
      apps: Record<string, unknown>[];
    };
    expect(view.projects).toEqual(["ST"]);
    expect(
      view.apps.map((a) => [
        a.name,
        a.path,
        a.sharedPaths,
        a.versioning,
        a.environments,
      ]),
    ).toEqual([
      [
        "api",
        "backend/api",
        ["packages/core", "packages/db"],
        "date",
        ["staging", "prod"],
      ],
      ["cli", "backend/cli", ["packages/core", "packages/sdk"], "semver", []],
      [
        "web",
        "web/app",
        ["packages/core", "packages/sdk"],
        "date",
        ["staging", "prod"],
      ],
    ]);
    expect((await spider("repo", "list", "--project", "ST")).stdout).toBe(
      [
        "pipisasa/spider-tracker  main  ST",
        "  api  backend/api (+ packages/core, packages/db)  date  staging → prod",
        "  cli  backend/cli (+ packages/core, packages/sdk)  semver  no environments",
        "  web  web/app (+ packages/core, packages/sdk)  date  staging → prod",
        "",
      ].join("\n"),
    );
    expect((await spider("repo", "list", "--project", "SPI")).stdout).toBe(
      "No repos\n",
    );
    expect((await spider("app", "list", "--json")).json().items).toHaveLength(
      3,
    );

    // Attach to a second project and back; apps change and go.
    expect(
      (
        await spider(
          "repo",
          "attach",
          "pipisasa/spider-tracker",
          "ops",
          "--json",
        )
      ).json(),
    ).toMatchObject({ projects: ["OPS", "ST"] });
    expect(
      (
        await spider(
          "repo",
          "detach",
          "pipisasa/spider-tracker",
          "OPS",
          "--json",
        )
      ).json(),
    ).toMatchObject({ projects: ["ST"] });
    expect(
      (
        await spider(
          "app",
          "update",
          "web",
          "--env",
          "prod",
          "--shared",
          "",
          "--json",
        )
      ).json(),
    ).toMatchObject({
      environments: ["prod"],
      sharedPaths: [],
    });
    expect(
      (
        await spider(
          "app",
          "update",
          "web",
          "--env",
          "staging,prod",
          "--shared",
          "packages/core,packages/sdk",
        )
      ).code,
    ).toBe(0);
    expect((await spider("app", "update", "web")).code).toBe(2);
    expect((await spider("app", "add", "tmp", "--path", ".")).code).toBe(0);
    expect((await spider("app", "remove", "tmp", "--json")).json()).toEqual({
      repo: "pipisasa/spider-tracker",
      app: "tmp",
      removed: true,
    });
    expect((await spider("app", "remove", "tmp")).code).toBe(3);
    expect(
      (
        await spider(
          "repo",
          "update",
          "pipisasa/spider-tracker",
          "--default-branch",
          "main",
          "--json",
        )
      ).json(),
    ).toMatchObject({
      defaultBranch: "main",
    });
    expect((await spider("repo", "view", "nobody/nothing")).code).toBe(3);
    expect((await spider("repo", "view", "not a repo")).code).toBe(2);
  });

  test("task git: pull requests, branches and commits linked from GitHub (ST-84)", async () => {
    // GitHub events, as the webhook hands them to core: SPI uses the repo too.
    expect(
      (await spider("repo", "attach", "pipisasa/spider-tracker", "SPI")).code,
    ).toBe(0);
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    const [ownerActor] = await db
      .select()
      .from(schema.actors)
      .where(
        and(
          eq(schema.actors.orgId, org?.id ?? ""),
          eq(schema.actors.role, "owner"),
        ),
      );
    const owner: ActorContext = {
      orgId: org?.id ?? "",
      actorId: ownerActor?.id ?? "",
      role: "owner",
      source: "ui",
    };
    const installationId = stamp + 400;
    await saveGithubInstallation(db, owner, {
      installation: {
        id: installationId,
        account: "pipisasa",
        accountType: "User",
        repositorySelection: "selected",
        suspended: false,
      },
      repositories: [
        { owner: "pipisasa", name: "spider-tracker", defaultBranch: "main" },
      ],
    });
    const repository = { name: "spider-tracker", owner: { login: "pipisasa" } };
    let n = 0;
    const deliver = (event: string, payload: Record<string, unknown>) =>
      handleGithubWebhook(db, {
        deliveryId: `${stamp}-cli-${++n}`,
        event,
        payload: {
          installation: { id: installationId },
          repository,
          ...payload,
        },
      });

    expect((await spider("task", "git", "SPI-1")).stdout).toBe(
      "Nothing linked to SPI-1 in git yet\n",
    );
    await deliver("push", {
      ref: "refs/heads/spi-1-ship-the-cli",
      commits: [
        {
          id: "a".repeat(40),
          message: "Ship the CLI\n\nmore",
          timestamp: "2026-10-12T10:00:00Z",
          author: { name: "Ann", username: "ann" },
        },
      ],
    });
    await deliver("pull_request", {
      action: "opened",
      number: 12,
      pull_request: {
        number: 12,
        title: "Ship the CLI",
        body: "Closes SPI-1",
        state: "open",
        draft: true,
        updated_at: "2026-10-12T11:00:00Z",
        head: { ref: "spi-1-ship-the-cli" },
        base: { ref: "main" },
        user: { login: "ann" },
      },
    });
    expect((await spider("task", "git", "SPI-1")).stdout).toBe(
      [
        "Pull requests:",
        "  pipisasa/spider-tracker#12  draft  Ship the CLI  (spi-1-ship-the-cli → main, @ann)",
        "",
        "Branches:",
        "  pipisasa/spider-tracker  spi-1-ship-the-cli",
        "",
        "Commits:",
        "  aaaaaaa  2026-10-12  Ship the CLI  (ann)",
        "",
      ].join("\n"),
    );
    expect(
      (await spider("task", "git", "SPI-1", "--json")).json(),
    ).toMatchObject({
      taskKey: "SPI-1",
      pullRequests: [
        { number: 12, state: "open", draft: true, via: "closing" },
      ],
      branches: [{ name: "spi-1-ship-the-cli", deleted: false }],
      commits: [{ sha: "a".repeat(40), via: "branch" }],
    });
    // From the current branch's key.
    Bun.spawnSync({
      cmd: ["git", "checkout", "-q", "-B", "spi-1-ship-the-cli"],
      cwd: repo,
    });
    expect((await spider("task", "git", "--json")).json()).toMatchObject({
      taskKey: "SPI-1",
    });
    expect((await spider("task", "git", "nope")).code).toBe(2);
    expect((await spider("task", "git", "SPI-999")).code).toBe(3);
  });

  test("releases: a release in ST includes three Done tasks and is marked Released; all three show shipped <version>; the board puts it in Released (ST-93)", async () => {
    const done = async (project: string, title: string) => {
      const created = await spider(
        "task",
        "create",
        "--project",
        project,
        "--title",
        title,
        "--status",
        "Done",
        "--json",
      );
      expect(created.code).toBe(0);
      return created.json().key as string;
    };
    const keys = [
      await done("ST", "Task kinds"),
      await done("ST", "Dates"),
      await done("SPI", "From another project"),
    ];
    const candidates = await spider("release", "candidates", "--json");
    expect(
      (candidates.json().items as { key: string }[]).map((t) => t.key),
    ).toEqual(expect.arrayContaining(keys));
    expect((await spider("task", "view", keys[0] ?? "")).stdout).toContain(
      "Shipping: not in a release",
    );

    // The origin remote (pipisasa/spider-tracker) is the apps' repo.
    const created = await spider(
      "release",
      "create",
      "--project",
      "ST",
      "--title",
      "2026.10.13",
      "--app",
      "web=2026.10.13",
      "--app",
      "cli=v0.1.8",
      "--task",
      `${keys[0]},${keys[1]}`,
      "--json",
    );
    expect(created.code).toBe(0);
    const release = created.json() as {
      key: string;
      status: { name: string };
      apps: { name: string; version: string }[];
    };
    expect(release).toMatchObject({
      kind: "release",
      title: "2026.10.13",
      status: { name: "Planned" },
      repos: [{ fullName: "pipisasa/spider-tracker" }],
      apps: [
        { name: "cli", version: "0.1.8" },
        { name: "web", version: "2026.10.13" },
      ],
    });
    expect(
      (await spider("release", "add", release.key, keys[2] ?? "")).stdout,
    ).toContain(`Tasks (3):`);
    expect(
      (
        await spider("release", "add", "--json", release.key, keys[2] ?? "")
      ).json().tasks,
    ).toHaveLength(3);
    expect(
      (
        await spider(
          "release",
          "create",
          "--project",
          "ST",
          "--title",
          "x",
          "--app",
          "web=1.0.0",
        )
      ).stderr,
    ).toContain("isn't a date version");
    expect((await spider("task", "view", keys[2] ?? "")).stdout).toContain(
      `Shipping: 2026.10.13 · planned (${release.key})`,
    );

    // The first deploy moves it to On staging (ST-94); Released waits for web in prod.
    const staged = await spider(
      "release",
      "deploy",
      release.key,
      "--app",
      "web",
      "--env",
      "staging",
      "--commit",
      "3F2C1AB",
    );
    expect(staged.stdout).toBe(
      `Recorded web → staging at 3f2c1ab for ${release.key} (2026.10.13)\n${release.key} moved Planned → On staging\n`,
    );
    expect((await spider("task", "done", release.key)).stderr).toContain(
      "it isn't deployed web to prod yet",
    );
    expect((await spider("release", "view", release.key)).stdout).toContain(
      "Deployments:\n  web  staging  3f2c1ab  ",
    );
    const prod = await spider(
      "release",
      "deploy",
      release.key,
      "--app",
      "web",
      "--env",
      "prod",
      "--commit",
      "3f2c1ab",
      "--json",
    );
    expect(prod.json()).toMatchObject({
      deployment: { app: "web", environment: "prod", production: true },
      release: { status: { name: "On staging" } },
      movedFrom: null,
    });
    // Released through the ordinary status change; the tasks stay Done.
    expect(
      (await spider("task", "done", release.key, "--json")).json(),
    ).toMatchObject({ status: { name: "Released" } });
    for (const key of keys) {
      const view = await spider("task", "view", key, "--json");
      expect(view.json()).toMatchObject({
        status: { name: "Done" },
        shipping: {
          state: "shipped",
          release: { key: release.key, title: "2026.10.13" },
        },
      });
      expect((await spider("task", "view", key)).stdout).toContain(
        `Shipping: shipped 2026.10.13 (${release.key})`,
      );
    }
    expect(
      (await spider("task", "list", "--project", "ST", "--status", "done"))
        .stdout,
    ).toContain("[shipped 2026.10.13]");
    expect((await spider("release", "view", release.key)).stdout).toMatch(
      new RegExp(`^${release.key}  2026\\.10\\.13  Released  \\(shipped `),
    );
    expect(
      (await spider("release", "list", "--project", "ST", "--app", "web"))
        .stdout,
    ).toBe(
      `${release.key}  2026.10.13  Released  cli 0.1.8, web 2026.10.13  3 tasks\n`,
    );

    // The board: release columns after the task columns, the release in the Released column.
    const sdk = createClient({
      baseUrl: env.API_ORIGIN,
      token,
      fetch: (input, init) => app.request(input, init),
    });
    const [detail, tasks, releases] = await Promise.all([
      sdk.projects.get(slug, "ST"),
      sdk.tasks.list(slug, "ST", { kind: "task" }),
      sdk.releases.list(slug, "ST"),
    ]);
    const columns = boardColumns(detail, tasks.items, releases.items);
    const column = columns.find(
      (c) =>
        c.type === "releases" && c.releases.some((r) => r.key === release.key),
    );
    expect(column?.status.name).toBe("Released");
    expect(columns.findIndex((c) => c === column)).toBeGreaterThan(
      columns.findIndex((c) => c.type === "tasks" && c.status.name === "Done"),
    );

    // Shipped: no more changes; no code; a removed task is a candidate again.
    expect(
      (await spider("release", "remove", release.key, keys[0] ?? "")).code,
    ).toBe(2);
    const second = (
      await spider(
        "release",
        "create",
        "--project",
        "ST",
        "--title",
        "2026.10.14",
        "--json",
      )
    ).json().key as string;
    const late = await done("ST", "Late");
    expect((await spider("release", "add", second, late)).code).toBe(0);
    expect(
      (await spider("release", "remove", second, late, "--json")).json().tasks,
    ).toEqual([]);
    expect(
      (await spider("task", "update", late, "--no-code", "--json")).json(),
    ).toMatchObject({ noCode: true, shipping: { state: "no_code" } });
    expect(
      (await spider("task", "list", "--project", "ST", "--status", "done"))
        .stdout,
    ).toContain("[no code]");
  });

  test("milestones: create, task update --milestone (sub-tasks inherit), roadmap with progress; Done tasks with no code make it Ready to close (ST-96)", async () => {
    const created = await spider(
      "milestone",
      "create",
      "--project",
      "ST",
      "--title",
      "Phase 9: Polish",
      "--description",
      "**Goal:** x",
      "--target",
      "2026-12-01",
      "--status",
      "Active",
      "--json",
    );
    expect(created.code).toBe(0);
    const milestone = created.json() as {
      key: string;
      kind: string;
      status: { name: string };
    };
    expect(milestone).toMatchObject({
      kind: "milestone",
      status: { name: "Active" },
      progress: { total: 0 },
      tasks: [],
    });
    const create = async (...args: string[]) =>
      (
        await spider("task", "create", "--project", "ST", ...args, "--json")
      ).json().key as string;
    const parent = await create(
      "--title",
      "Polish parent",
      "--milestone",
      milestone.key,
    );
    const child = await create("--title", "Polish child", "--parent", parent);
    expect((await spider("task", "view", child)).stdout).toContain(
      `Milestone: ${milestone.key} Phase 9: Polish (Active), from its parent`,
    );
    const loose = await create("--title", "Polish loose");
    expect(
      (
        await spider(
          "task",
          "update",
          loose,
          "--milestone",
          milestone.key,
          "--json",
        )
      ).json(),
    ).toMatchObject({ milestone: { key: milestone.key, inherited: false } });
    expect(
      (
        await spider("task", "update", loose, "--milestone", "", "--json")
      ).json(),
    ).toMatchObject({ milestoneId: null, milestone: null });
    expect(
      (
        await spider(
          "task",
          "update",
          "--project",
          "ST",
          "--milestone",
          milestone.key,
        )
      ).code,
    ).toBe(2);
    expect(
      (await spider("task", "update", loose, "--milestone", parent)).stderr,
    ).toContain("not a milestone");

    expect((await spider("roadmap", "ST")).stdout).toMatch(
      new RegExp(
        `${milestone.key}\\s+Phase 9: Polish\\s+Active\\s+target 2026-12-01\\s+0/2 done`,
      ),
    );
    const bulk = await spider(
      "task",
      "update",
      parent,
      child,
      "--status",
      "Done",
      "--no-code",
      "--json",
    );
    expect(bulk.json()).toMatchObject({ summary: { changed: 2, failed: 0 } });

    const view = (await spider("milestone", "view", milestone.key)).stdout;
    expect(view).toStartWith(
      `${milestone.key}  Phase 9: Polish  Ready to close\nTarget: 2026-12-01\nProgress: 2/2 done · ready to close\nTasks (2):\n`,
    );
    expect(view).toContain(`(sub-task of ${parent})  [no code]`);
    expect(view).toEndWith("\n\n**Goal:** x\n");
    const ready = (
      await spider(
        "milestone",
        "list",
        "ST",
        "--status",
        "Ready to close",
        "--json",
      )
    ).json() as { items: { key: string }[] };
    expect(ready.items.map((m) => m.key)).toEqual([milestone.key]);
  });

  test("CLI --json and MCP return tasks, documents, comments, document comments and projects in the same shape (ST-107)", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${env.API_ORIGIN}/mcp`),
      {
        fetch: async (url, init) => app.request(url, init),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    const client = new Client({ name: "parity-test", version: "0.0.0" });
    await client.connect(transport);
    const mcp = async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(result.isError ?? false).toBe(false);
      return JSON.parse(result.content[0]?.text ?? "null");
    };
    const cli = async (...argv: string[]): Promise<unknown> => {
      const result = await spider(...argv, "--json");
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout);
    };
    /** The field names, recursively, so values that change between two calls (updatedAt) don't matter. */
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.slice(0, 1).map(shape)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, shape(v)]),
            )
          : typeof value;

    try {
      // A task with a sub-task, a link, a document and a comment, so every nested list has something.
      const child = (
        await spider(
          "task",
          "create",
          "--project",
          "SPI",
          "--title",
          "Parity child",
          "--parent",
          "SPI-1",
          "--tag",
          "cli",
          "--target",
          "2020-01-31",
          "--json",
        )
      ).json();
      await spider("link", "SPI-1", "relates", child.key as string);
      await spider("comment", "SPI-1", "Parity check");

      // Reads are the same, value for value.
      expect(await mcp("get_task", { key: "SPI-1" })).toEqual(
        await cli("task", "view", "SPI-1"),
      );
      expect(
        await mcp("list_tasks", { projectKey: "SPI", limit: 200 }),
      ).toEqual({
        ...((await cli(
          "task",
          "list",
          "--project",
          "SPI",
          "--limit",
          "200",
        )) as object),
        total: expect.any(Number),
      });
      expect(
        await mcp("list_tasks", { projectKey: "SPI", overdue: true }),
      ).toEqual({
        ...((await cli(
          "task",
          "list",
          "--project",
          "SPI",
          "--overdue",
        )) as object),
        total: 1,
      });
      expect(await mcp("list_documents", { project: "SPI" })).toEqual(
        await cli("doc", "list", "--project", "SPI"),
      );
      const doc = (
        (await cli("doc", "list", "--project", "SPI")) as {
          items: { id: string; version: number }[];
        }
      ).items.find((d) => d.version > 1);
      expect(doc).toBeDefined();
      expect(await mcp("get_document", { id: doc?.id })).toEqual(
        await cli("doc", "view", doc?.id ?? ""),
      );
      expect(await mcp("get_document", { id: doc?.id, version: 1 })).toEqual(
        await cli("doc", "view", doc?.id ?? "", "--rev", "1"),
      );
      expect(await mcp("diff_document", { id: doc?.id, from: 1 })).toEqual(
        await cli("doc", "diff", doc?.id ?? "", "--from", "1"),
      );
      expect(await mcp("list_comments", { key: "SPI-1" })).toEqual(
        await cli("comments", "SPI-1"),
      );
      // Git links (ST-84): TaskGitDto on both sides.
      expect(await mcp("get_task_git", { key: "SPI-1" })).toEqual(
        await cli("task", "git", "SPI-1"),
      );
      // Document comments (ST-118), with a quoted fragment, a reply and a resolved thread.
      const docComment = (await cli(
        "doc",
        "comment",
        doc?.id ?? "",
        "Parity review",
      )) as { id: string };
      await cli(
        "doc",
        "comment",
        doc?.id ?? "",
        "Agreed",
        "--reply-to",
        docComment.id,
      );
      await cli("doc", "resolve", doc?.id ?? "", docComment.id);
      const listedText = (await spider("doc", "comments", doc?.id ?? ""))
        .stdout;
      expect(listedText).toContain(`${docComment.id} (resolved by @`);
      expect(listedText).toMatch(/\n {2}@[\w-]+ · .*\n {2}Agreed/);
      expect(
        (
          await spider(
            "doc",
            "comment",
            doc?.id ?? "",
            "x",
            "--quote",
            "a",
            "--reply-to",
            docComment.id,
          )
        ).code,
      ).toBe(2);
      expect(await mcp("list_document_comments", { id: doc?.id })).toEqual(
        await cli("doc", "comments", doc?.id ?? ""),
      );
      // Backlinks and the documents graph (ST-101), with a document that mentions SPI-1.
      stdin = "Mentions [[SPI-1]]";
      await cli(
        "doc",
        "create",
        "--title",
        "Parity links",
        "--project",
        "SPI",
        "--file",
        "-",
      );
      const backlinks = await cli("doc", "backlinks", "SPI-1");
      expect(backlinks).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ title: "Parity links" }),
        ]),
      });
      expect(await mcp("list_backlinks", { task: "SPI-1" })).toEqual(backlinks);
      expect(await mcp("get_document_graph")).toEqual(
        await cli("doc", "graph"),
      );
      expect(await mcp("list_projects")).toEqual(await cli("projects"));
      // With rules (ST-111), get_project and project view give them as ProjectRulesDto.
      expect(
        await cli("project", "update", "SPI", "--rules", doc?.id ?? ""),
      ).toMatchObject({ rulesDocumentId: doc?.id });
      // Status automation from pull requests (ST-85): update_project and project update change it alike.
      const automated = await mcp("update_project", {
        projectKey: "SPI",
        gitAutomation: { closed: "canceled", draft: null },
      });
      expect(automated).toEqual(
        await cli(
          "project",
          "update",
          "SPI",
          "--on-closed",
          "Canceled",
          "--on-draft",
          "none",
        ),
      );
      expect(automated).toMatchObject({
        gitAutomation: {
          enabled: true,
          draft: null,
          opened: "in_review",
          merged: "done",
          closed: "canceled",
        },
      });
      await cli("project", "update", "SPI", "--automation", "defaults");
      // project view adds task counts per status, which get_project leaves out.
      const view = (await cli("project", "view", "SPI")) as {
        statuses: Record<string, unknown>[];
        workflows: Record<string, Record<string, unknown>[]>;
      };
      expect(view).toMatchObject({
        rules: {
          projectKey: "SPI",
          documentId: doc?.id,
          content: expect.any(String),
        },
      });
      const uncounted = (statuses: Record<string, unknown>[]) =>
        statuses.map((status) => {
          const rest = { ...status };
          delete rest.taskCount;
          return rest;
        });
      expect(await mcp("get_project", { projectKey: "SPI" })).toEqual({
        ...view,
        statuses: uncounted(view.statuses),
        workflows: Object.fromEntries(
          Object.entries(view.workflows).map(([kind, statuses]) => [
            kind,
            uncounted(statuses),
          ]),
        ),
      });

      // Repos and apps (ST-92): RepoDto and AppDto on both sides.
      expect(await mcp("list_repos")).toEqual(await cli("repo", "list"));
      expect(
        await mcp("get_repo", { repo: "pipisasa/spider-tracker" }),
      ).toEqual(await cli("repo", "view", "pipisasa/spider-tracker"));
      expect(
        await mcp("attach_repo", {
          repo: "pipisasa/spider-tracker",
          projectKey: "ST",
        }),
      ).toEqual(await cli("repo", "attach", "pipisasa/spider-tracker", "ST"));
      expect(
        shape(
          await mcp("add_app", {
            repo: "pipisasa/spider-tracker",
            name: "docs",
            path: "docs",
          }),
        ),
      ).toEqual(
        shape(
          await cli(
            "app",
            "add",
            "site",
            "--repo",
            "pipisasa/spider-tracker",
            "--path",
            "site",
          ),
        ),
      );
      expect(
        await mcp("update_app", {
          repo: "pipisasa/spider-tracker",
          app: "docs",
          versioning: "date",
        }),
      ).toEqual(
        await cli(
          "app",
          "update",
          "docs",
          "--repo",
          "pipisasa/spider-tracker",
          "--versioning",
          "date",
        ),
      );

      // Releases (ST-93): ReleaseView on both sides; candidates as tasks.
      const releaseKey =
        (
          (await cli("release", "list", "--project", "ST")) as {
            items: { key: string }[];
          }
        ).items[0]?.key ?? "";
      expect(await mcp("get_release", { key: releaseKey })).toEqual(
        await cli("release", "view", releaseKey),
      );
      expect(await mcp("list_releases", { projectKey: "ST" })).toEqual(
        await cli("release", "list", "--project", "ST"),
      );
      expect(
        await mcp("list_release_candidates", { projectKey: "SPI" }),
      ).toEqual(await cli("release", "candidates", "--project", "SPI"));
      const mcpRelease = (await mcp("create_release", {
        projectKey: "ST",
        title: "2026.11.01",
        apps: [
          {
            repo: "pipisasa/spider-tracker",
            app: "web",
            version: "2026.11.01",
          },
        ],
      })) as { key: string };
      const cliRelease = (await cli(
        "release",
        "create",
        "--project",
        "ST",
        "--title",
        "2026.11.02",
        "--app",
        "pipisasa/spider-tracker:web=2026.11.02",
      )) as { key: string };
      expect(shape(mcpRelease)).toEqual(shape(cliRelease));
      expect(
        await mcp("update_release", {
          key: mcpRelease.key,
          apps: [
            { repo: "pipisasa/spider-tracker", app: "cli", version: "0.2.0" },
          ],
        }),
      ).toEqual(
        await cli(
          "release",
          "update",
          mcpRelease.key,
          "--app",
          "pipisasa/spider-tracker:cli=0.2.0",
        ),
      );
      const parityTask = (
        (await cli(
          "task",
          "create",
          "--project",
          "SPI",
          "--title",
          "Parity release",
          "--status",
          "Done",
        )) as { key: string }
      ).key;
      const addedMcp = await mcp("add_to_release", {
        key: mcpRelease.key,
        tasks: [parityTask],
      });
      expect(
        await mcp("remove_from_release", {
          key: mcpRelease.key,
          tasks: [parityTask],
        }),
      ).toEqual(await cli("release", "view", mcpRelease.key));
      expect(addedMcp).toEqual(
        await cli("release", "add", mcpRelease.key, parityTask),
      );
      // Changelogs (ST-95): the server's changelog on both sides (the CLI without its git grouping).
      expect(await mcp("get_release_changelog", { key: releaseKey })).toEqual(
        await cli("release", "changelog", releaseKey, "--no-git"),
      );
      const mcpWritten = await mcp("get_release_changelog", {
        key: mcpRelease.key,
        write: true,
      });
      expect(mcpWritten).toMatchObject({
        written: "added",
        description: { state: "current" },
      });
      // Writing again changes nothing; otherwise the same changelog.
      expect(
        await cli(
          "release",
          "changelog",
          mcpRelease.key,
          "--write",
          "--no-git",
        ),
      ).toEqual({ ...(mcpWritten as object), written: "unchanged" });

      // Milestones (ST-96): MilestoneView on both sides.
      const mcpMilestone = (await mcp("create_milestone", {
        projectKey: "SPI",
        title: "Parity milestone",
        targetDate: "2026-12-01",
      })) as { key: string };
      const cliMilestone = (await cli(
        "milestone",
        "create",
        "--project",
        "SPI",
        "--title",
        "Parity CLI milestone",
        "--target",
        "2026-12-02",
      )) as { key: string };
      expect(shape(mcpMilestone)).toEqual(shape(cliMilestone));
      await cli(
        "task",
        "update",
        child.key as string,
        "--milestone",
        mcpMilestone.key,
      );
      expect(await mcp("get_milestone", { key: mcpMilestone.key })).toEqual(
        await cli("milestone", "view", mcpMilestone.key),
      );
      expect(await mcp("list_milestones", { projectKey: "SPI" })).toEqual(
        await cli("roadmap", "SPI"),
      );

      // Writes return the same fields.
      expect(
        shape(await mcp("update_task", { key: "SPI-1", priority: 1 })),
      ).toEqual(shape(await cli("task", "update", "SPI-1", "--priority", "2")));
      expect(
        shape(
          await mcp("update_task", {
            key: "SPI-1",
            startDate: "2020-01-01",
            targetDate: "2020-02-01",
          }),
        ),
      ).toEqual(
        shape(
          await cli(
            "task",
            "update",
            "SPI-1",
            "--start",
            "2020-01-02",
            "--target",
            "2020-02-02",
          ),
        ),
      );
      expect(
        shape(await mcp("add_comment", { key: "SPI-1", body: "From MCP" })),
      ).toEqual(shape(await cli("comment", "SPI-1", "From CLI")));
      expect(
        shape(
          await mcp("add_document_comment", { id: doc?.id, body: "From MCP" }),
        ),
      ).toEqual(shape(await cli("doc", "comment", doc?.id ?? "", "From CLI")));
      await mcp("resolve_document_comment", {
        id: doc?.id,
        comment_id: docComment.id,
        resolved: false,
      });
      expect(
        shape(
          await mcp("resolve_document_comment", {
            id: doc?.id,
            comment_id: docComment.id,
          }),
        ),
      ).toEqual(
        shape(await cli("doc", "resolve", doc?.id ?? "", docComment.id)),
      );
      expect(
        shape(
          await mcp("update_tasks", {
            keys: ["SPI-1", "SPI-999"],
            priority: 3,
          }),
        ),
      ).toEqual(
        shape(
          await spider(
            "task",
            "update",
            "SPI-1",
            "SPI-999",
            "--priority",
            "3",
            "--json",
          ).then((r) => r.json()),
        ),
      );
      // Workflow edits (ST-90) answer with the project and its workflows.
      expect(
        shape(
          await mcp("update_status", {
            projectKey: "SPI",
            kind: "release",
            status: "Planned",
            color: "#111111",
          }),
        ),
      ).toEqual(
        shape(
          await cli(
            "project",
            "status",
            "update",
            "SPI",
            "Planned",
            "--kind",
            "release",
            "--color",
            "#222222",
          ),
        ),
      );
      expect(
        shape(
          await mcp("create_document", { title: "Parity", project: "SPI" }),
        ),
      ).toEqual(
        shape(
          await cli(
            "doc",
            "create",
            "--title",
            "Parity CLI",
            "--project",
            "SPI",
          ),
        ),
      );
    } finally {
      await client.close();
    }
  });

  test("task update --status Todo --priority 1: works by name, category or number, and says why it fails (ST-107)", async () => {
    await spider(
      "task",
      "create",
      "--project",
      "SPI",
      "--title",
      "Status and priority",
    );
    const key =
      (
        (await spider("task", "list", "--project", "SPI", "--json")).json()
          .items as { key: string; title: string }[]
      ).find((t) => t.title === "Status and priority")?.key ?? "";
    for (const [status, priority] of [
      ["Todo", "1"],
      ["todo", "urgent"],
      ["TODO", "1"],
      ["in_progress", "2"],
      ["Todo", "1"],
    ] as const) {
      const updated = await spider(
        "task",
        "update",
        key,
        "--status",
        status,
        "--priority",
        priority,
        "--json",
      );
      expect(updated).toMatchObject({ code: 0, stderr: "" });
      expect(updated.json()).toMatchObject({
        key,
        status: { category: status === "in_progress" ? "in_progress" : "todo" },
      });
    }
    expect((await spider("task", "view", key, "--json")).json()).toMatchObject({
      status: { name: "Todo" },
      priority: 1,
    });

    const failure = async (
      argv: string[],
      code: number,
      message: string,
      extra: Record<string, string> = {},
    ) => {
      const result = await spiderAs(argv, extra);
      expect(result.code).toBe(code);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    };
    await failure(
      ["task", "update", key, "--status", "To Do", "--priority", "1"],
      2,
      'Unknown status "To Do" in SPI. Valid statuses: Backlog, Todo',
    );
    await failure(
      ["task", "update", key, "--status", "Todo", "--priority", "5"],
      2,
      'Invalid priority "5"',
    );
    await failure(
      ["task", "update", "NOPE-49", "--status", "Todo", "--priority", "1"],
      3,
      "Project NOPE not found",
    );

    // The likely cause of the reported failure: the CLI acted as another saved agent (here the
    // default one, limited to another project) than the MCP session, so the task read as missing.
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        email: ownerEmail,
        callbackURL: `${env.WEB_ORIGIN}/`,
      }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (
      await app.request(link.pathname + link.search, { redirect: "manual" })
    ).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const post = async <T = unknown>(path: string, body: unknown) => {
      const res = await app.request(path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    };
    await post(`/v1/orgs/${slug}/projects`, { name: "Other", key: "OTH" });
    const configDir = mkdtempSync(join(tmpdir(), "spider-config-"));
    try {
      const invite = await post<{ invite: { code: string } }>(
        `/v1/orgs/${slug}/agent-invites`,
        { projectKeys: ["OTH"] },
      );
      const accepted = await spiderAs(
        [
          "accept-invite",
          invite.invite.code,
          "--server",
          "local",
          "--handle",
          "oth-bot",
          "--no-claude",
        ],
        {
          SPIDER_CONFIG_DIR: configDir,
        },
      );
      expect(accepted.code).toBe(0);
      await failure(
        ["task", "update", key, "--status", "Todo", "--priority", "1"],
        3,
        `Project SPI not found (acting as local/${slug}/oth-bot, the default agent, which sees only OTH; pass --as <agent> to act as another)`,
        { SPIDER_CONFIG_DIR: configDir },
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
