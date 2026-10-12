import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "@repo/api/src/app";
import { createAuth } from "@repo/api/src/auth";
import { loadEnv } from "@repo/api/src/env";
import type { Mailer } from "@repo/api/src/mailer";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, ownerEmail));
    await db.$client.end();
  });

  const spider = (...argv: string[]) => spiderVia((input, init) => app.request(input, init), argv);

  async function spiderVia(fetch: (input: string, init: RequestInit) => Response | Promise<Response>, argv: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await run(argv, {
      env: { SPIDER_TOKEN: token, SPIDER_API_URL: env.API_ORIGIN },
      fetch,
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s) },
      cwd: repo,
      stdin: async () => stdin,
    });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  }

  test("owner sets up a project and an agent key", async () => {
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: ownerEmail, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const verify = await app.request(link.pathname + link.search, { redirect: "manual" });
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
    const agent = await post<{ actor: { id: string } }>(`/v1/orgs/${slug}/agents`, { name: "CLI Bot" });
    agentId = agent.actor.id;
    const key = await post<{ secret: string }>(`/v1/orgs/${slug}/agents/${agentId}/keys`, { name: "cli" });
    token = key.secret;
    expect(token).toStartWith("spt_");
  });

  test("whoami and projects", async () => {
    const who = await spider("whoami", "--json");
    expect(who.code).toBe(0);
    expect(who.json()).toMatchObject({ actor: { id: agentId }, organization: { slug } });
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
    expect(task).toMatchObject({ key: "SPI-1", title: "Ship the CLI", priority: 2, status: { category: "todo" } });
    expect((await spider("task", "create", "--project", "SPI", "--title", "Other", "--assign", "me")).code).toBe(0);

    const mine = await spider("task", "list", "--mine", "--json");
    expect((mine.json().items as { key: string }[]).map((t) => t.key)).toEqual(["SPI-2"]);
    const backlog = await spider("task", "list", "--project", "SPI", "--status", "todo", "--limit", "1", "--json");
    expect((backlog.json().items as unknown[]).length).toBe(1);

    // No key: the CLI takes it from the branch name.
    Bun.spawnSync({ cmd: ["git", "init", "-q", "-b", "spi-1-ship-cli"], cwd: repo });
    const started = await spider("task", "start", "--json");
    expect(started.code).toBe(0);
    expect(started.json()).toMatchObject({
      key: "SPI-1",
      status: { category: "in_progress" },
      assigneeIds: [agentId],
      assignees: ["cli-bot"],
    });

    const done = await spider("task", "done", "SPI-1", "--json");
    expect(done.json()).toMatchObject({ key: "SPI-1", status: { category: "done" } });
    expect(done.json().completedAt).not.toBeNull();

    const log = await db.select().from(schema.activity).where(eq(schema.activity.entityId, task.id as string));
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(new Set(log.map((e) => e.source))).toEqual(new Set(["cli"]));

    expect((await spider("task", "view", "SPI-99")).code).toBe(3);
    expect((await spider("task", "update", "SPI-1", "--assign", "nobody")).code).toBe(2);
  });
  test("login through the browser, use the saved key, then logout", async () => {
    // A fresh sign-in for the person approving in the "browser".
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: ownerEmail, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (await app.request(link.pathname + link.search, { redirect: "manual" })).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const configDir = mkdtempSync(join(tmpdir(), "spider-config-"));
    const loginEnv = { SPIDER_API_URL: env.API_ORIGIN, SPIDER_CONFIG_DIR: configDir };
    const as = async (argv: string[], extra: Partial<Parameters<typeof run>[1]> = {}) => {
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
        await db.update(schema.deviceCodes).set({ lastPolledAt: null }).where(eq(schema.deviceCodes.userCode, userCode));
      },
    });
    expect(login.code).toBe(0);
    expect(login.stderr).toContain("confirm the code");
    expect(JSON.parse(login.stdout)).toMatchObject({ actor: { name: "spider CLI · Test Box" }, organization: { slug } });

    const file = join(configDir, "credentials.json");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");

    const who = await as(["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ actor: { handle: "cli-test-box" } });

    const store = JSON.parse(readFileSync(file, "utf8")) as Store;
    expect(store.default).toEqual({ server: "local", org: slug, agent: "cli-test-box" });
    const saved = store.servers.local?.orgs[slug]?.agents["cli-test-box"]?.token ?? "";
    expect(saved).toStartWith("spt_");
    expect((await as(["logout"])).stdout).toBe("Signed out @cli-test-box\n");
    expect(existsSync(file)).toBe(false);
    expect((await app.request("/v1/whoami", { headers: { Authorization: `Bearer ${saved}` } })).status).toBe(401);
    expect((await as(["whoami"])).code).toBe(4);
    rmSync(configDir, { recursive: true, force: true });
  });
  test("accept-invite saves agents per server and org; --as switches between them", async () => {
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: ownerEmail, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (await app.request(link.pathname + link.search, { redirect: "manual" })).headers
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
    const first = await as(["accept-invite", (await invite()).toLowerCase(), "--server", "local", "--name", "Reviewer", "--json"]);
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
    for (const out of [first, second]) expect(out.stdout + out.stderr).not.toContain("spt_");

    // A taken handle is a conflict (exit 2) and leaves the code usable.
    const code = await invite();
    expect((await as(["accept-invite", code, "--server", "local", "--handle", "writer"])).code).toBe(2);
    expect((await as(["accept-invite", code, "--server", "local", "--handle", "editor", "--default"])).code).toBe(0);

    const file = join(configDir, "credentials.json");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    const store = JSON.parse(readFileSync(file, "utf8")) as Store;
    expect(store.default).toEqual({ server: "local", org: slug, agent: "editor" });
    expect(Object.keys(store.servers.local?.orgs[slug]?.agents ?? {})).toEqual(["reviewer", "writer", "editor"]);
    expect(store.servers.local?.orgs[slug]?.agents.reviewer).toMatchObject({ source: "invite", projects: [{ key: "SPI" }] });

    const handleOf = async (argv: string[], extra: Record<string, string> = {}) =>
      (JSON.parse((await as([...argv, "--json"], extra)).stdout) as { actor: { handle: string }; agent: string | null });
    expect(await handleOf(["whoami"])).toMatchObject({ actor: { handle: "editor" }, agent: `local/${slug}/editor` });
    expect((await handleOf(["whoami", "--as", "reviewer"])).actor.handle).toBe("reviewer");
    expect((await handleOf(["--as", `${slug}/writer`, "whoami"])).actor.handle).toBe("writer");
    expect((await handleOf(["whoami"], { SPIDER_AGENT: "writer" })).actor.handle).toBe("writer");
    expect(await handleOf(["whoami"], { SPIDER_TOKEN: token, SPIDER_API_URL: env.API_ORIGIN })).toMatchObject({
      actor: { handle: "cli-bot" },
      agent: null,
    });

    // Each got a Claude Code agent in the private plugin; --claude deletes it with the agent.
    const writerAgent = join(configDir, "claude-plugin", "spider-agents", "agents", "local", slug, "writer.md");
    expect(readFileSync(writerAgent, "utf8")).toContain(`spider-agent: local/${slug}/writer`);
    const removed = await as(["agents", "remove", "writer", "--revoke", "--claude"]);
    expect(removed.stdout).toBe(`Removed local/${slug}/writer and revoked its key\nDeleted Claude Code agent ${writerAgent}\n`);
    const writerKey = store.servers.local?.orgs[slug]?.agents.writer?.token ?? "";
    expect((await app.request("/v1/whoami", { headers: { Authorization: `Bearer ${writerKey}` } })).status).toBe(401);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("comments, inbox and the Claude Code channel", async () => {
    // The owner, in the browser, mentions the agent (handle "cli-bot") on SPI-1.
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: ownerEmail, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (await app.request(link.pathname + link.search, { redirect: "manual" })).headers
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
    const commented = await spider("comment", "SPI-1", "Picked", "this", "up", "--json");
    expect(commented.code).toBe(0);
    expect(commented.json()).toMatchObject({ taskKey: "SPI-1", body: "Picked this up" });
    expect((await spider("comment", "--json")).code).toBe(2);

    expect((await ownerComment("@cli-bot did the CLI ship?")).status).toBe(201);
    const inbox = await spider("inbox", "--json", "--mark-read");
    const items = inbox.json().items as { kind: string; task: { key: string } }[];
    expect(items.map((i) => [i.kind, i.task.key])).toContainEqual(["mention", "SPI-1"]);
    expect((await spider("inbox", "--json")).json()).toEqual({ items: [] });
    expect((await spider("comments", "SPI-1")).stdout).toContain("did the CLI ship?");

    // Channel: a new mention is pushed into the "session"; the session replies with the tool.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createChannel } = await import("./channel");
    const { createClient } = await import("@repo/sdk");
    const channel = createChannel({
      client: createClient({ baseUrl: env.API_ORIGIN, token, source: "cli", fetch: (i, init) => app.request(i, init) }),
      org: slug,
      handle: "cli-bot",
      waitSeconds: 2,
      retryMs: 100,
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const session = new Client({ name: "claude-code-test", version: "0" });
    const pushed: { content: string; meta: Record<string, string> }[] = [];
    session.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel") pushed.push(n.params as (typeof pushed)[number]);
    };
    await channel.server.connect(serverSide);
    await session.connect(clientSide);
    expect(session.getServerCapabilities()?.experimental).toHaveProperty("claude/channel");
    expect(session.getInstructions()).toContain("@cli-bot");

    const stop = new AbortController();
    const pumping = channel.pump(stop.signal);
    await ownerComment("@cli-bot please also check the docs");
    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(100);
    expect(pushed[0]?.meta).toMatchObject({ task: "SPI-1", kind: "mention", from_type: "human" });
    expect(pushed[0]?.content).toContain("please also check the docs");

    const reply = await session.callTool({
      name: "reply",
      arguments: { task: "SPI-1", text: "Docs checked", reply_to: pushed[0]?.meta.comment_id },
    });
    expect(reply.isError).toBeFalsy();
    const thread = await app.request(`/v1/orgs/${slug}/tasks/SPI-1/comments`, { headers: { Cookie: cookie } });
    const comments = ((await thread.json()) as { items: { body: string; parentId: string | null }[] }).items;
    expect(comments.at(-1)).toMatchObject({ body: "Docs checked", parentId: pushed[0]?.meta.comment_id });

    stop.abort();
    await pumping;
    await session.close();
  });
  test("tags: list, set on create and update, unknown names fail with the list", async () => {
    // Agents (members) can create tags through the API; the CLI only reads and assigns them.
    const res = await app.request(`/v1/orgs/${slug}/tags`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cli" }),
    });
    expect(res.status).toBe(201);
    expect((await spider("tags")).stdout).toBe("cli\n");

    const created = await spider("task", "create", "--project", "SPI", "--title", "Tagged", "--tag", "#CLI", "--json");
    expect(created.json()).toMatchObject({ tags: ["cli"] });
    const key = created.json().key as string;
    expect((await spider("task", "view", key)).stdout).toContain("Tags: cli");
    expect((await spider("task", "update", key, "--tag", "nope")).stderr).toContain("Existing tags: cli");
    // An empty --tag clears the tags, like --description "".

    await spider("task", "create", "--project", "SPI", "--title", "Tagged urgent", "--tag", "cli", "--priority", "1");
    const listed = await spider("task", "list", "--project", "SPI", "--tag", "CLI", "--priority", "1,high", "--json");
    expect((listed.json().items as { title: string }[]).map((t) => t.title)).toEqual(["Tagged urgent"]);
    expect((await spider("task", "list", "--project", "SPI", "--tag", "cli", "--priority", "urgent")).stdout).toContain("Tagged urgent");
    expect((await spider("task", "list", "--project", "SPI", "--tag", "cli", "--priority", "4")).stdout).toBe("No tasks\n");
    const unknown = await spider("task", "list", "--project", "SPI", "--tag", "nope");
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Existing tags: cli");
    expect((await spider("task", "update", key, "--tag", "", "--json")).json()).toMatchObject({ tags: [] });
  });

  test("a deactivated assignee is shown by handle, not id", async () => {
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slug));
    if (!org) throw new Error("no org");
    const [gone] = await db
      .insert(schema.actors)
      .values({ orgId: org.id, type: "agent", name: "Gone", handle: "gone", role: "member" })
      .returning();
    if (!gone) throw new Error("insert failed");
    const created = await spider("task", "create", "--project", "SPI", "--title", "Orphaned", "--assign", "gone", "--json");
    const key = created.json().key as string;
    await db.update(schema.actors).set({ deactivatedAt: new Date() }).where(eq(schema.actors.id, gone.id));

    expect((await spider("task", "view", key)).stdout).toContain("@gone (deactivated)");
    expect((await spider("task", "view", key, "--json")).json()).toMatchObject({ assignees: ["gone (deactivated)"] });
    expect((await spider("task", "list", "--project", "SPI")).stdout).toContain("@gone (deactivated)");
    expect((await spider("task", "update", key, "--assign", "gone")).code).not.toBe(0);
    // Orphaned assignments can be found by the deactivated handle (ST-65).
    const orphaned = await spider("task", "list", "--project", "SPI", "--assignee", "@gone", "--json");
    expect((orphaned.json().items as { key: string }[]).map((t) => t.key)).toEqual([key]);
  });

  test("--any-tag, and the filters still hold against a server that ignores them", async () => {
    await app.request(`/v1/orgs/${slug}/tags`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ops" }),
    });
    for (const [title, tags] of [["Has cli", "cli"], ["Has ops", "ops"], ["Has both", "cli,ops"]] as const) {
      await spider("task", "create", "--project", "SPI", "--title", title, "--tag", tags, "--priority", "3");
    }
    // The agent's owner: part of "mine", unlike "me".
    await spider("task", "create", "--project", "SPI", "--title", "For the owner", "--assign", `cli-owner-${stamp}`, "--priority", "3");
    const titles = async (via: typeof spider, ...args: string[]) => {
      const result = await via("task", "list", "--project", "SPI", "--limit", "500", "--json", ...args);
      expect(result.code).toBe(0);
      return (result.json().items as { title: string }[]).map((t) => t.title).sort();
    };
    // An API from before ST-50 knows no filters: it drops the query and returns every task.
    const old = (...argv: string[]) => spiderVia((input, init) => app.request(input.split("?")[0] ?? input, init), argv);
    const everything = await titles(spider);
    expect(everything.length).toBeGreaterThan(3);

    for (const via of [spider, old]) {
      expect(await titles(via, "--tag", "cli,ops")).toEqual(["Has both"]);
      expect(await titles(via, "--tag", "cli,ops", "--any-tag", "--priority", "3")).toEqual(["Has both", "Has cli", "Has ops"]);
      expect(await titles(via, "--tag", "ops", "--any-tag")).toEqual(["Has both", "Has ops"]);
      expect(await titles(via, "--assignee", "@none", "--priority", "medium", "--status", "todo")).toEqual(["Has both", "Has cli", "Has ops"]);
      expect(await titles(via, "--mine", "--priority", "3")).toEqual([]);
      expect(await titles(via, "--assignee", "mine", "--priority", "3")).toEqual(["For the owner"]);
      expect(await titles(via, "--assignee", "@Mine,none", "--priority", "3")).toEqual(["For the owner", "Has both", "Has cli", "Has ops"]);
      expect(await titles(via)).toEqual(everything);
    }
  });

  test("task update with several keys, or by filter with a preview until --yes (ST-106)", async () => {
    const parent = (await spider("task", "create", "--project", "SPI", "--title", "Bulk parent", "--json")).json().key as string;
    const kids: string[] = [];
    for (const title of ["Bulk 1", "Bulk 2", "Bulk 3"]) {
      kids.push((await spider("task", "create", "--project", "SPI", "--title", title, "--parent", parent, "--json")).json().key as string);
    }
    const [k1 = "", k2 = "", k3 = ""] = kids;
    const statusOf = async (key: string) => ((await spider("task", "view", key, "--json")).json().status as { name: string }).name;

    // Several keys: --status sets, as for one key; a missing task fails alone, with exit code 1.
    const byKeys = await spider("task", "update", k1, k2, "SPI-999", "--status", "In Review", "--assign", "me");
    expect(byKeys.code).toBe(1);
    expect(byKeys.stdout).toContain(`${k1.padEnd(7)}  changed  In Review  Bulk 1`);
    expect(byKeys.stdout).toContain("SPI-999  failed   Task SPI-999 not found");
    expect(byKeys.stdout).toEndWith("2 changed, 0 unchanged, 1 failed\n");
    expect(await statusOf(k2)).toBe("In Review");
    const again = await spider("task", "update", k1, k2, "--set-status", "in_review", "--json");
    expect(again.code).toBe(0);
    expect(again.json()).toMatchObject({
      dryRun: false,
      summary: { changed: 0, unchanged: 2, failed: 0 },
      results: [{ key: k1, outcome: "unchanged", task: { status: { name: "In Review" }, assignees: ["cli-bot"] } }, { key: k2 }],
    });

    // By filter: --status filters and --set-status sets; without --yes it only previews.
    const filter = ["task", "update", "--project", "spi", "--parent", parent, "--status", "in_review", "--set-status", "Backlog"];
    const preview = await spider(...filter);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain(`${k1}  would change  Backlog  Bulk 1`);
    expect(preview.stdout).toEndWith("Dry run: 2 would change, 0 unchanged, 0 failed; nothing was changed. Run again with --yes to apply.\n");
    expect(await statusOf(k1)).toBe("In Review");
    const applied = await spider(...filter, "--yes", "--json");
    expect(applied.json()).toMatchObject({ dryRun: false, summary: { changed: 2 }, results: [{ key: k1 }, { key: k2 }] });
    expect(await statusOf(k1)).toBe("Backlog");
    expect(await statusOf(k3)).toBe("Todo");
    expect((await spider(...filter, "--yes")).stdout).toBe("No matching tasks\n");

    // --dry-run previews several keys too.
    const dry = await spider("task", "update", k3, k1, "--status", "Done", "--dry-run", "--json");
    expect(dry.json()).toMatchObject({ dryRun: true, summary: { changed: 2 } });
    expect(await statusOf(k3)).toBe("Todo");

    const usage = async (...argv: string[]) => {
      const result = await spider(...argv);
      expect(result.code).toBe(2);
      return result.stderr;
    };
    expect(await usage("task", "update", k1, "--project", "SPI", "--set-status", "Done")).toContain("not both");
    expect(await usage("task", "update", "--project", "SPI", "--assign", "me")).toContain("--set-assign");
    expect(await usage("task", "update", "--project", "SPI", "--status", "todo")).toContain("--set-status");
    expect(await usage("task", "update", k1, k2, "--title", "Same")).toContain("one task at a time");
    expect(await usage("task", "update", k1, "--status", "Done", "--set-status", "Todo")).toContain("not both");
    expect(await usage("task", "update", k1, "--assignee", "me")).toContain("--project");
    expect(await usage("task", "update", "--project", "SPI", "--status", "Nope", "--set-status", "Done")).toContain('Unknown status "Nope"');
  });

  test("sub-tasks: --parent on create, shown by view, cleared with an empty --parent", async () => {
    const child = await spider("task", "create", "--project", "SPI", "--title", "Child", "--parent", "spi-1", "--json");
    expect(child.json()).toMatchObject({ parentKey: "SPI-1" });
    const key = child.json().key as string;
    const parent = await spider("task", "view", "SPI-1", "--json");
    expect(parent.json().url).toBe(`${env.WEB_ORIGIN}/${slug}/tasks/SPI-1`);
    expect((parent.json().subtasks as { key: string }[]).map((t) => t.key)).toContain(key);
    expect((await spider("task", "view", "SPI-1")).stdout).toContain("Sub-tasks:");
    expect((await spider("task", "view", key)).stdout).toContain("Parent: SPI-1");
    expect((await spider("task", "update", key, "--parent", "", "--json")).json()).toMatchObject({ parentKey: null });
  });

  test("links: link, shown by view from both sides, unlink; bad kinds are usage errors", async () => {
    const other = (await spider("task", "create", "--project", "SPI", "--title", "Waits on SPI-1", "--json")).json().key as string;
    expect((await spider("link", "SPI-1", "blocks", other)).stdout).toBe(`Linked: SPI-1 blocks ${other}\n`);
    expect((await spider("task", "view", other)).stdout).toContain("blocked by SPI-1");
    expect((await spider("task", "view", other, "--json")).json().relations).toEqual([
      { kind: "blocked_by", task: "SPI-1", title: expect.any(String) },
    ]);
    expect((await spider("unlink", other, "Blocked-By", "SPI-1", "--json")).json()).toMatchObject({ linked: false });
    expect((await spider("link", "SPI-1", "depends", other)).code).toBe(2);
  });

  test("docs: create from a file and stdin, list by scope, view, edit from a base version", async () => {
    writeFileSync(join(repo, "spec.html"), "<h1>Spec</h1>");
    const spec = (await spider("doc", "create", "--title", "Spec", "--project", "spi", "--file", "spec.html", "--json")).json();
    expect(spec).toMatchObject({ projectKey: "SPI", taskKey: null, format: "html", content: "<h1>Spec</h1>", version: 1 });
    const id = spec.id as string;
    // The web page's address (ST-115).
    const url = `${env.WEB_ORIGIN}/${slug}/docs/${id}`;
    expect(spec.url).toBe(url);

    stdin = "# Notes";
    const notes = (await spider("doc", "create", "--title", "Notes", "--task", "spi-1", "--file", "-", "--json")).json();
    expect(notes).toMatchObject({ taskKey: "SPI-1", format: "md", content: "# Notes" });

    expect((await spider("doc", "list", "--task", "SPI-1")).stdout).toBe(`${notes.id as string}  SPI-1  v1  Notes\n`);
    const all = (await spider("doc", "list", "--project", "SPI", "--json")).json().items as { title: string }[];
    expect(all.map((d) => d.title).sort()).toEqual(["Notes", "Spec"]);

    stdin = "<h1>Spec v2</h1>";
    expect((await spider("doc", "edit", id, "--file", "-", "--base-version", "1")).stdout).toBe("Saved Spec as version 2\n");
    expect((await spider("doc", "edit", id, "--title", "Spec", "--base-version", "2")).stdout).toBe("No changes to Spec\n");

    // An edit based on version 1 must not overwrite version 2 (ST-21).
    stdin = "<h1>Stale</h1>";
    const stale = await spider("doc", "edit", id, "--file", "-", "--base-version", "1", "--json");
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain('"code":"conflict"');
    // Without a base version the edit is refused unless forced.
    expect((await spider("doc", "edit", id, "--title", "Spec 2")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--title", "Spec", "--base-version", "x")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--title", "Spec", "--force")).stdout).toBe("No changes to Spec\n");
    expect((await spider("doc", "view", id)).stdout).toContain("<h1>Spec v2</h1>");
    expect((await spider("doc", "view", id)).stdout).toContain(`\n${url}\n`);
    expect((await spider("doc", "view", id, "--rev", "1", "--json")).json()).toMatchObject({
      version: 1,
      currentVersion: 2,
      content: "<h1>Spec</h1>",
      url,
    });
    expect((await spider("doc", "edit", id)).code).toBe(2);
    expect((await spider("doc", "view", "00000000-0000-7000-8000-000000000000")).code).toBe(3);
  });

  test("docs: partial edits with --old/--new, --append and --section, no --force needed (ST-116)", async () => {
    stdin = "# Plan\n\nIntro.\n\n## Decisions\n\nOld.\n\n## Next\n\nLater.\n";
    const created = (await spider("doc", "create", "--title", "Plan", "--project", "SPI", "--file", "-", "--json")).json();
    const id = created.id as string;

    expect((await spider("doc", "edit", id, "--old", "Intro.", "--new", "Hello.")).stdout).toBe("Saved Plan as version 2\n");
    stdin = "New.\n";
    expect((await spider("doc", "edit", id, "--section", "## Decisions", "--file", "-", "--base-version", "2")).stdout).toBe(
      "Saved Plan as version 3\n",
    );
    const appended = (await spider("doc", "edit", id, "--append", "--text", "Done.", "--json")).json();
    expect(appended).toMatchObject({
      version: 4,
      content: "# Plan\n\nHello.\n\n## Decisions\n\nNew.\n\n## Next\n\nLater.\nDone.",
    });
    expect((await spider("doc", "edit", id, "--old", "Done.", "--new", "Done.")).stdout).toBe("No changes to Plan\n");

    const missing = await spider("doc", "edit", id, "--old", "Intro.", "--new", "x", "--json");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('"code":"conflict"');
    const stale = await spider("doc", "edit", id, "--append", "--text", "late", "--base-version", "3");
    expect(stale.code).toBe(2);
    expect((await spider("doc", "edit", id, "--old", "e", "--new", "E")).code).toBe(2);

    // Usage errors: a partial edit is one of the three, with its text.
    expect((await spider("doc", "edit", id, "--old", "Hello.")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--append")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--append", "--text", "a", "--section", "## Next")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--old", "a", "--new", "b", "--title", "T")).code).toBe(2);
    expect((await spider("doc", "edit", id, "--text", "a", "--force")).code).toBe(2);
    expect((await spider("doc", "view", id, "--json")).json()).toMatchObject({ version: 4, title: "Plan" });
  });

  test("docs: move to the organization and back to a project", async () => {
    stdin = "# Movable";
    const created = (await spider("doc", "create", "--title", "Movable", "--project", "SPI", "--file", "-", "--json")).json();
    const id = created.id as string;
    expect((await spider("doc", "move", id, "--org")).stdout).toBe("Moved Movable to the organization\n");
    expect((await spider("doc", "move", id, "--project", "spi", "--json")).json()).toMatchObject({ id, projectKey: "SPI", version: 1 });
    expect((await spider("doc", "move", id)).code).toBe(2);
    expect((await spider("doc", "move", id, "--org", "--project", "SPI")).code).toBe(2);
    expect((await spider("doc", "move", id, "--project", "NOPE")).code).toBe(3);
  });

  test("projects: an agent acts with its owner's rights; refused when the owner is a member", async () => {
    const [ownerActor] = await db
      .select({ id: schema.actors.id })
      .from(schema.agents)
      .innerJoin(schema.actors, eq(schema.actors.id, schema.agents.ownerId))
      .where(eq(schema.agents.actorId, agentId));
    const ownerId = ownerActor?.id ?? "";
    await db.update(schema.actors).set({ role: "member" }).where(eq(schema.actors.id, ownerId));
    try {
      const refused = await spider("project", "create", "--key", "OPS", "--name", "Ops", "--json");
      expect(refused.code).toBe(4);
      expect(JSON.parse(refused.stderr)).toEqual({ error: { code: "forbidden", message: "Your role can't create projects" } });
    } finally {
      await db.update(schema.actors).set({ role: "owner" }).where(eq(schema.actors.id, ownerId));
    }

    const created = await spider("project", "create", "--key", "ops", "--name", "Ops", "--description", "Runbooks", "--json");
    expect(created.code).toBe(0);
    expect(created.json()).toMatchObject({ key: "OPS", name: "Ops", description: "Runbooks", archivedAt: null });
    expect((await spider("project", "create", "--key", "OPS", "--name", "Again")).code).toBe(2);
    expect((await spider("task", "create", "--project", "OPS", "--title", "Rotate keys")).code).toBe(0);

    const view = await spider("project", "view", "ops", "--json");
    expect(view.json()).toMatchObject({ key: "OPS", archivedAt: null });
    const counts = (view.json().statuses as { name: string; taskCount: number }[]).map((s) => [s.name, s.taskCount]);
    expect(counts).toEqual([["Backlog", 0], ["Todo", 1], ["In Progress", 0], ["In Review", 0], ["Done", 0], ["Canceled", 0]]);
    const human = (await spider("project", "view", "OPS")).stdout;
    expect(human).toStartWith("OPS  Ops\n");
    expect(human).toContain("  Todo         1\n");
    expect(human).toEndWith("\nRunbooks\n");

    const updated = await spider("project", "update", "OPS", "--name", "Operations", "--description", "", "--json");
    expect(updated.json()).toMatchObject({ key: "OPS", name: "Operations", description: null });
    expect((await spider("project", "update", "OPS")).code).toBe(2);

    expect((await spider("project", "archive", "OPS")).stdout).toBe("Archived OPS  Operations\n");
    expect((await spider("projects")).stdout).toBe("SPI  Spider\n");
    expect((await spider("projects", "--archived")).stdout).toBe("SPI  Spider\nOPS  Operations  (archived)\n");
    expect((await spider("project", "view", "OPS", "--json")).json().archivedAt).not.toBeNull();
    const late = await spider("task", "create", "--project", "OPS", "--title", "Too late");
    expect(late).toMatchObject({ code: 2, stderr: "spider: Project OPS is archived\n" });

    const restored = await spider("project", "archive", "OPS", "--undo", "--json");
    expect(restored.json()).toMatchObject({ key: "OPS", archivedAt: null });
    expect((await spider("projects", "--json")).json().items).toMatchObject([{ key: "SPI" }, { key: "OPS" }]);
    expect((await spider("project", "view", "NOPE")).code).toBe(3);

    // ST-40's "done when": then a doc in the agent's new project.
    stdin = "# Runbook";
    const doc = await spider("doc", "create", "--title", "Runbook", "--project", "OPS", "--file", "-", "--json");
    expect(doc.code).toBe(0);
    expect(doc.json()).toMatchObject({ projectKey: "OPS", title: "Runbook" });
  });

});
