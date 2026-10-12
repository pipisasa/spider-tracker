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

  async function spider(...argv: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await run(argv, {
      env: { SPIDER_TOKEN: token, SPIDER_API_URL: env.API_ORIGIN },
      fetch: (input, init) => app.request(input, init),
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
    expect((await spider("task", "update", key, "--tag", "", "--json")).json()).toMatchObject({ tags: [] });
  });

  test("sub-tasks: --parent on create, shown by view, cleared with an empty --parent", async () => {
    const child = await spider("task", "create", "--project", "SPI", "--title", "Child", "--parent", "spi-1", "--json");
    expect(child.json()).toMatchObject({ parentKey: "SPI-1" });
    const key = child.json().key as string;
    const parent = await spider("task", "view", "SPI-1", "--json");
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
    expect((await spider("doc", "view", id, "--rev", "1", "--json")).json()).toMatchObject({
      version: 1,
      currentVersion: 2,
      content: "<h1>Spec</h1>",
    });
    expect((await spider("doc", "edit", id)).code).toBe(2);
    expect((await spider("doc", "view", "00000000-0000-7000-8000-000000000000")).code).toBe(3);
  });

  test("projects: a member agent is refused; an admin creates, views, updates, archives and restores", async () => {
    const refused = await spider("project", "create", "--key", "OPS", "--name", "Ops", "--json");
    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.stderr)).toEqual({ error: { code: "forbidden", message: "Your role can't create projects" } });

    await db.update(schema.actors).set({ role: "admin" }).where(eq(schema.actors.id, agentId));
    try {
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
    } finally {
      await db.update(schema.actors).set({ role: "member" }).where(eq(schema.actors.id, agentId));
    }
  });

});
