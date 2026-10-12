import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ActorContext } from "@repo/core";
import {
  MIN_CLI_VERSION,
  addComment,
  addDocumentComment,
  createAgent,
  createApiKey,
  createDocument,
  createOrganization,
  createProject,
  createTask,
  deleteAgent,
  listInbox,
  updateProject,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";

const databaseUrl = process.env.TEST_DATABASE_URL;

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
});

const db = createDb(env.DATABASE_URL);
const app = createApp({ db, auth: createAuth(db, env, { async sendMagicLink() {} }), env });

afterAll(() => db.$client.end());

test("/mcp requires an agent API key", async () => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toStartWith("Bearer");
  expect(res.headers.get("X-Spider-Min-Cli")).toBe(MIN_CLI_VERSION);
  expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
});

/** An MCP client whose HTTP requests go straight to the app. */
async function connect(secret: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${env.API_ORIGIN}/mcp`), {
    fetch: async (url, init) => app.request(url, init),
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const client = new Client({ name: "spider-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type ToolText = { content: { type: string; text: string }[]; isError?: boolean };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolText;
  const text = result.content[0]?.text ?? "";
  return { isError: result.isError ?? false, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

const withDb = databaseUrl ? describe : describe.skip;

withDb("MCP server", () => {
  const stamp = Date.now();
  const slugs = [`mcp-${stamp}`, `mcp-other-${stamp}`];
  const userIds = [`test-${crypto.randomUUID()}`, `test-${crypto.randomUUID()}`];
  let client: Client;
  let otherClient: Client;
  const agentIds: string[] = [];
  const ownerCtxs: ActorContext[] = [];
  const secrets: string[] = [];

  /** Creates an org with a project and an agent key; returns the key's secret. */
  async function setUpOrg(i: number) {
    const userId = userIds[i] ?? "";
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const { organization, actor } = await createOrganization(
      db,
      { id: userId, name: "Owner", email: `owner-${i}@example.com` },
      { name: "MCP Org", slug: slugs[i] },
    );
    const ctx: ActorContext = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    ownerCtxs[i] = ctx;
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    const agent = await createAgent(db, ctx, { name: "Claude Code" });
    agentIds[i] = agent.actor.id;
    const { secret } = await createApiKey(db, ctx, agent.actor.id, { name: "test" });
    secrets[i] = secret;
    return secret;
  }

  beforeAll(async () => {
    client = await connect(await setUpOrg(0));
    otherClient = await connect(await setUpOrg(1));
  });

  afterAll(async () => {
    await client.close();
    await otherClient.close();
    await db.delete(schema.organizations).where(inArray(schema.organizations.slug, slugs));
    await db.delete(schema.user).where(inArray(schema.user.id, userIds));
  });

  test("lists the tracker tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_comment",
        "add_document_comment",
        "archive_project",
        "assign_to_me",
        "create_document",
        "diff_document",
        "create_project",
        "create_tag",
        "create_task",
        "get_document",
        "get_document_graph",
        "list_backlinks",
        "list_documents",
        "move_document",
        "edit_document",
        "update_document",
        "update_project",
        "get_inbox",
        "get_task_activity",
        "list_comments",
        "list_document_comments",
        "resolve_document_comment",
        "mark_inbox_read",
        "get_project",
        "get_task",
        "list_members",
        "list_tags",
        "link_tasks",
        "list_projects",
        "list_tasks",
        "mark_duplicate",
        "start_task",
        "unlink_tasks",
        "update_task",
        "update_tasks",
        "whoami",
      ].sort(),
    );
  });

  test("whoami is the key's agent", async () => {
    expect((await call(client, "whoami")).json()).toMatchObject({
      organization: { slug: slugs[0] },
      you: { handle: "claude-code" },
    });
  });

  test("create_task → start_task → get_task, recorded with source mcp", async () => {
    const created = await call(client, "create_task", {
      projectKey: "spi",
      title: "Wire up MCP",
      priority: 2,
      assignees: ["@owner-0"],
    });
    expect(created.isError).toBe(false);
    expect(created.json()).toMatchObject({ key: "SPI-1", status: { name: "Todo", category: "todo" }, priority: 2, assignees: ["owner-0"] });

    const started = await call(client, "start_task", { key: "SPI-1" });
    expect(started.json()).toMatchObject({ status: { name: "In Progress" }, assignees: ["owner-0", "claude-code"] });

    const task = await call(client, "get_task", { key: "spi-1" });
    expect(task.json()).toMatchObject({ key: "SPI-1", title: "Wire up MCP", status: { name: "In Progress" }, subtasks: [], relations: [], documents: [] });
    // The web page's address (ST-115).
    expect(task.json()).toMatchObject({ url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/tasks/SPI-1` });

    const mine = await call(client, "list_tasks", { projectKey: "SPI", assignee: "me", status: "in progress" });
    expect(mine.json()).toMatchObject({ total: 1, items: [{ key: "SPI-1" }] });
    const done = await call(client, "list_tasks", { projectKey: "SPI", status: "done" });
    expect(done.json()).toMatchObject({ total: 0 });

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slugs[0] ?? ""));
    const rows = await db
      .select({ action: schema.activity.action, source: schema.activity.source })
      .from(schema.activity)
      .where(and(eq(schema.activity.orgId, org?.id ?? ""), eq(schema.activity.entityType, "task")));
    expect(rows.map((r) => r.action).sort()).toEqual(["task.created", "task.updated"]);
    expect(rows.every((r) => r.source === "mcp")).toBe(true);
  });

  test("tags by name on create and update; unknown names list the existing ones", async () => {
    expect((await call(client, "create_tag", { name: "infra" })).isError).toBeFalsy();
    const created = await call(client, "create_task", { projectKey: "SPI", title: "Tagged", tags: ["Infra"] });
    expect(created.json()).toMatchObject({ tags: ["infra"] });
    const bad = await call(client, "update_task", { key: created.json().key, tags: ["nope"] });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toContain("infra");
    expect(JSON.parse((await call(client, "list_tags")).text)).toEqual([{ name: "infra", color: null }]);

    const listed = await call(client, "list_tasks", { projectKey: "SPI", tags: ["INFRA"], priority: [0, 1] });
    expect(listed.json()).toMatchObject({ total: 1, items: [{ title: "Tagged", tags: ["infra"] }] });
    expect((await call(client, "list_tasks", { projectKey: "SPI", tags: ["infra"], priority: [2] })).json()).toMatchObject({
      total: 0,
    });
    // tagMatch: all by default, any on request; status and assignee also take arrays.
    expect((await call(client, "create_tag", { name: "docs" })).isError).toBeFalsy();
    await call(client, "create_task", { projectKey: "SPI", title: "Docs only", tags: ["docs"] });
    const both = { projectKey: "SPI", tags: ["infra", "docs"] };
    expect((await call(client, "list_tasks", both)).json()).toMatchObject({ total: 0 });
    const any = (await call(client, "list_tasks", { ...both, tagMatch: "any", status: ["todo", "backlog"], assignee: ["none", "@me"] })).json() as {
      items: { title: string }[];
    };
    expect(any.items.map((t) => t.title).sort()).toEqual(["Docs only", "Tagged"]);
    const unknownTag = await call(client, "list_tasks", { projectKey: "SPI", tags: ["nope"] });
    expect(unknownTag).toMatchObject({ isError: true });
    expect(unknownTag.text).toContain("infra");
  });

  test("sub-tasks: create with a parent key, see them on the parent, clear the parent", async () => {
    const child = (await call(client, "create_task", { projectKey: "SPI", title: "Child", parent: "SPI-1" })).json() as {
      key: string;
      parentKey: string | null;
    };
    expect(child.parentKey).toBe("SPI-1");
    const parent = (await call(client, "get_task", { key: "SPI-1" })).json() as { subtasks: { key: string }[] };
    expect(parent.subtasks.map((t) => t.key)).toContain(child.key);
    const cleared = await call(client, "update_task", { key: child.key, parent: null });
    expect(cleared.json()).toMatchObject({ parentKey: null, parentId: null });
  });

  test("start and target dates on create_task, update_task and update_tasks; list_tasks overdue (ST-91)", async () => {
    const created = await call(client, "create_task", { projectKey: "SPI", title: "Dated", startDate: "2020-01-01", targetDate: "2020-01-31" });
    expect(created.json()).toMatchObject({ startDate: "2020-01-01", targetDate: "2020-01-31", status: { category: "todo" } });
    const key = String(created.json().key);
    expect((await call(client, "list_tasks", { projectKey: "SPI", overdue: true })).json()).toMatchObject({ total: 1, items: [{ key }] });

    const backwards = await call(client, "update_task", { key, startDate: "2020-02-15" });
    expect(backwards).toMatchObject({ isError: true, text: expect.stringContaining("on or before the target date") });
    expect(await call(client, "create_task", { projectKey: "SPI", title: "Bad", targetDate: "Jan 31" })).toMatchObject({ isError: true });

    expect((await call(client, "update_task", { key, startDate: null, targetDate: "2999-12-31" })).json()).toMatchObject({
      startDate: null,
      targetDate: "2999-12-31",
    });
    expect((await call(client, "list_tasks", { projectKey: "SPI", overdue: true })).json()).toMatchObject({ total: 0 });
    const bulk = await call(client, "update_tasks", { keys: [key], targetDate: "2020-06-01" });
    expect(bulk.json()).toMatchObject({ summary: { changed: 1 }, results: [{ task: { targetDate: "2020-06-01" } }] });
    const cleared = await call(client, "update_tasks", { filter: { projectKey: "SPI", overdue: true }, targetDate: null });
    expect(cleared.json()).toMatchObject({ summary: { changed: 1 }, results: [{ key, task: { targetDate: null } }] });
  });

  test("relations: link, see them on get_task from both sides, unlink", async () => {
    const other = (await call(client, "create_task", { projectKey: "SPI", title: "Blocked" })).json() as { key: string };
    expect((await call(client, "link_tasks", { key: "SPI-1", kind: "blocks", task: other.key })).isError).toBeFalsy();
    const blocked = (await call(client, "get_task", { key: other.key })).json() as { relations: { kind: string; task: string; title: string }[] };
    expect(blocked.relations).toEqual([{ kind: "blocked_by", task: "SPI-1", title: expect.any(String) }]);
    expect((await call(client, "link_tasks", { key: other.key, kind: "blocks", task: "SPI-1" })).isError).toBe(true);
    expect((await call(client, "unlink_tasks", { key: other.key, kind: "blocked_by", task: "SPI-1" })).isError).toBeFalsy();
  });

  test("mark_duplicate: closes and links in one call, repeats change nothing, self and cycles are refused (ST-114)", async () => {
    const create = async (title: string) => ((await call(client, "create_task", { projectKey: "SPI", title })).json() as { key: string }).key;
    const [copy, original] = [await create("Copy"), await create("Original")];
    const marked = await call(client, "mark_duplicate", { key: copy, of: original, comment: "Same thing" });
    expect(marked.isError).toBeFalsy();
    expect(marked.json()).toMatchObject({ key: copy, status: { name: "Canceled", category: "canceled" }, completedAt: expect.any(String) });
    const seen = (await call(client, "get_task", { key: copy })).json() as { relations: { kind: string; task: string; title: string }[] };
    expect(seen.relations).toEqual([{ kind: "duplicates", task: original, title: "Original" }]);
    const again = await call(client, "mark_duplicate", { key: copy, of: original });
    expect(again.json()).toMatchObject({ updatedAt: marked.json().updatedAt });
    const comments = (await call(client, "list_comments", { key: copy })).text;
    expect(comments).toContain(`Duplicate of ${original}: Original`);
    expect(comments).toContain("Same thing");
    expect(comments.match(/Duplicate of/g)).toHaveLength(1);

    const self = await call(client, "mark_duplicate", { key: copy, of: copy });
    expect(self).toMatchObject({ isError: true });
    expect(self.text).toContain("itself");
    const cycle = await call(client, "mark_duplicate", { key: original, of: copy });
    expect(cycle).toMatchObject({ isError: true });
    expect(cycle.text).toContain("cycle");
  });

  test("documents: create, list, read, update with baseVersion; shown on get_project and get_task", async () => {
    const created = await call(client, "create_document", { title: "Spec", project: "SPI", content: "# v1" });
    expect(created.isError).toBeFalsy();
    const doc = created.json() as { id: string; version: number };
    expect(doc).toMatchObject({ projectKey: "SPI", taskKey: null, version: 1, authorId: agentIds[0], content: "# v1" });
    expect(created.json()).toMatchObject({ url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/docs/${doc.id}` });

    const onTask = (await call(client, "create_document", { title: "Notes", task: "SPI-1" })).json() as { id: string };
    expect((await call(client, "get_task", { key: "SPI-1" })).json()).toMatchObject({ documents: [{ id: onTask.id, title: "Notes" }] });
    const project = (await call(client, "get_project", { projectKey: "SPI" })).json() as { documents: { title: string }[] };
    expect(project.documents.map((d) => d.title).sort()).toEqual(["Notes", "Spec"]);
    expect(project).toMatchObject({ url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/projects/SPI` });

    const updated = await call(client, "update_document", { id: doc.id, baseVersion: 1, content: "# v2" });
    expect(updated.json()).toMatchObject({ version: 2 });
    const stale = await call(client, "update_document", { id: doc.id, baseVersion: 1, content: "# lost" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("version 2");

    expect((await call(client, "get_document", { id: doc.id })).json()).toMatchObject({ version: 2, content: "# v2" });
    expect((await call(client, "get_document", { id: doc.id, version: 1 })).json()).toMatchObject({
      id: doc.id,
      version: 1,
      currentVersion: 2,
      projectKey: "SPI",
      content: "# v1",
    });
    const listed = (await call(client, "list_documents", { task: "SPI-1" })).json() as { items: { title: string; taskKey: string }[] };
    expect(listed.items).toMatchObject([{ title: "Notes", taskKey: "SPI-1" }]);
    expect((await call(otherClient, "get_document", { id: doc.id })).isError).toBe(true);

    const orgWide = await call(client, "move_document", { id: doc.id, project: null });
    expect(orgWide.json()).toMatchObject({ id: doc.id, projectKey: null, version: 2 });
    expect((await call(client, "move_document", { id: doc.id, project: "NOPE" })).isError).toBe(true);
  });

  test("list_backlinks and get_document_graph follow links; a rename relinks (ST-101)", async () => {
    const target = (await call(client, "create_document", { title: "MCP target", project: "SPI" })).json() as { id: string };
    const source = (await call(client, "create_document", { title: "MCP source", content: "[[MCP target]] and SPI-1" })).json() as {
      id: string;
    };
    const renamed = await call(client, "update_document", { id: target.id, baseVersion: 1, title: "MCP target 2" });
    expect(renamed.json()).toMatchObject({ title: "MCP target 2", relinked: { rewritten: [{ id: source.id }], skipped: [] } });
    expect((await call(client, "get_document", { id: source.id })).json()).toMatchObject({ content: "[[MCP target 2]] and SPI-1" });

    const docBacklinks = ((await call(client, "list_backlinks", { id: target.id })).json() as { items: { id: string; url: string }[] }).items;
    expect(docBacklinks).toEqual([expect.objectContaining({ id: source.id, url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/docs/${source.id}` })]);
    const taskBacklinks = ((await call(client, "list_backlinks", { task: "spi-1" })).json() as { items: { id: string }[] }).items;
    expect(taskBacklinks.map((d) => d.id)).toEqual([source.id]);
    expect((await call(client, "list_backlinks", {})).isError).toBe(true);

    const graph = (await call(client, "get_document_graph")).json() as {
      links: { from: string; to: unknown }[];
      tasks: { key: string; url: string }[];
      documents: { id: string; projectKey: string | null }[];
      projects: { key: string; name: string; url: string }[];
    };
    expect(graph.documents).toContainEqual(expect.objectContaining({ id: target.id, projectKey: "SPI", version: 2 }));
    expect(graph.projects).toContainEqual({ key: "SPI", name: "Spider", url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/projects/SPI` });
    expect(graph.links.filter((l) => l.from === source.id).map((l) => l.to)).toEqual([
      { type: "document", id: target.id },
      { type: "task", key: "SPI-1" },
    ]);
    expect(graph.tasks).toContainEqual(expect.objectContaining({ key: "SPI-1", url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/tasks/SPI-1` }));
  });

  test("update_tasks: by keys or a filter, per-task results, dry run, scope checked per task (ST-106)", async () => {
    const parent = (await call(client, "create_task", { projectKey: "SPI", title: "Bulk parent" })).json();
    const kids: string[] = [];
    for (const title of ["Bulk kid 1", "Bulk kid 2"]) {
      kids.push(String((await call(client, "create_task", { projectKey: "SPI", title, parent: parent.key })).json().key));
    }

    const byKeys = await call(client, "update_tasks", { keys: [...kids, "SPI-999"], status: "In Review", assignees: ["me"], tags: [] });
    expect(byKeys.isError).toBe(false);
    expect(byKeys.json()).toMatchObject({
      dryRun: false,
      summary: { changed: 2, unchanged: 0, failed: 1 },
      results: [
        { key: kids[0], outcome: "changed", task: { status: { name: "In Review" }, assignees: ["claude-code"] }, error: null },
        { key: kids[1], outcome: "changed", task: { status: { name: "In Review" } } },
        { key: "SPI-999", outcome: "error", task: null, error: { code: "not_found", message: "Task SPI-999 not found" } },
      ],
    });

    const filter = { projectKey: "spi", parent: parent.key, status: "in_review" };
    const preview = await call(client, "update_tasks", { filter, status: "Backlog", priority: 4, dryRun: true });
    expect(preview.json()).toMatchObject({ dryRun: true, summary: { changed: 2 }, results: [{ task: { status: { name: "Backlog" }, priority: 4 } }, {}] });
    expect((await call(client, "list_tasks", { projectKey: "SPI", status: "backlog" })).json()).toMatchObject({ total: 0 });
    const applied = await call(client, "update_tasks", { filter, status: "Backlog" });
    expect(applied.json()).toMatchObject({ summary: { changed: 2 } });
    expect((await call(client, "list_tasks", { projectKey: "SPI", status: "backlog" })).json()).toMatchObject({ total: 2 });

    // Another organization's agent sees these tasks as missing, one by one.
    const foreign = await call(otherClient, "update_tasks", { keys: kids, priority: 1 });
    expect(foreign.json()).toMatchObject({ summary: { failed: 2 }, results: [{ outcome: "error" }, { outcome: "error" }] });

    expect(await call(client, "update_tasks", { keys: kids })).toMatchObject({ isError: true, text: expect.stringContaining("Nothing to update") });
    expect(await call(client, "update_tasks", { keys: kids, filter, priority: 1 })).toMatchObject({ isError: true });
    expect(await call(client, "update_tasks", { keys: kids, tags: ["nope"] })).toMatchObject({ isError: true });
  });

  test("edit_document: partial edits without resending the document", async () => {
    const doc = (
      await call(client, "create_document", { title: "Partial", content: "# Partial\n\nIntro.\n\n## Decisions\n\nOld.\n" })
    ).json() as { id: string };

    const edited = await call(client, "edit_document", { id: doc.id, edits: [{ old: "Intro.", new: "Hello." }] });
    expect(edited.json()).toMatchObject({ id: doc.id, version: 2, authorId: agentIds[0] });
    const sectioned = await call(client, "edit_document", {
      id: doc.id,
      baseVersion: 2,
      edits: [{ section: "## Decisions", content: "New." }, { append: "Done." }],
    });
    expect(sectioned.json()).toMatchObject({ version: 3 });
    expect((await call(client, "get_document", { id: doc.id })).json()).toMatchObject({
      content: "# Partial\n\nHello.\n\n## Decisions\n\nNew.\nDone.",
    });

    const missing = await call(client, "edit_document", { id: doc.id, edits: [{ old: "Intro.", new: "x" }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(`doesn't contain "Intro."`);
    const stale = await call(client, "edit_document", { id: doc.id, baseVersion: 2, edits: [{ append: "late" }] });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("version 3");
  });

  test("diff_document: a unified diff between versions, or against the current one (ST-117)", async () => {
    const doc = (await call(client, "create_document", { title: "Diffed", content: "# D\n\nold\n" })).json() as { id: string };
    await call(client, "edit_document", { id: doc.id, edits: [{ old: "old", new: "new" }] });

    const diff = await call(client, "diff_document", { id: doc.id, from: 1 });
    expect(diff.isError).toBeFalsy();
    expect(diff.json()).toMatchObject({
      documentId: doc.id,
      from: { version: 1, authorId: agentIds[0] },
      to: { version: 2, title: "Diffed" },
      added: 1,
      removed: 1,
      diff: "--- v1\n+++ v2\n@@ -1,3 +1,3 @@\n # D\n \n-old\n+new",
      hunks: [expect.objectContaining({ lines: expect.any(Array) })],
    });
    expect((await call(client, "diff_document", { id: doc.id, from: 2, to: 2 })).json()).toMatchObject({ diff: "" });
    const missing = await call(client, "diff_document", { id: doc.id, from: 1, to: 5 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Version 5 not found");
    expect((await call(otherClient, "diff_document", { id: doc.id, from: 1 })).isError).toBe(true);
  });

  test("statuses can be given by category, like the CLI", async () => {
    const moved = await call(client, "update_task", { key: "SPI-1", status: "in_review" });
    expect(moved.isError).toBeFalsy();
    expect(moved.text).toContain("In Review");
  });

  test("comments and inbox: a mention reaches the agent, which replies", async () => {
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, slugs[0] ?? ""));
    const [ownerRow] = await db
      .select()
      .from(schema.actors)
      .where(and(eq(schema.actors.orgId, org?.id ?? ""), eq(schema.actors.type, "human")));
    const ownerCtx: ActorContext = { orgId: org?.id ?? "", actorId: ownerRow?.id ?? "", role: "owner", source: "ui" };
    await addComment(db, ownerCtx, "SPI-1", { body: "@claude-code status?" });

    const inbox = await call(client, "get_inbox", { wait_seconds: 2 });
    const items = JSON.parse(inbox.text) as { id: number; kind: string; task: string; comment: { id: string } }[];
    const mention = items.find((i) => i.kind === "mention");
    expect(mention).toMatchObject({ task: "SPI-1" });

    const reply = await call(client, "add_comment", { key: "SPI-1", body: "Almost done", parent_id: mention?.comment.id });
    expect(reply.isError).toBeFalsy();
    expect(reply.json()).toMatchObject({ taskKey: "SPI-1", parentId: mention?.comment.id, body: "Almost done", author: "claude-code" });
    const thread = (await call(client, "list_comments", { key: "SPI-1" })).json() as { items: { author: string; authorId: string }[] };
    expect(thread.items.map((c) => c.author)).toEqual([ownerRow?.handle ?? "", "claude-code"]);
    expect(thread.items[0]?.authorId).toBe(ownerRow?.id ?? "");

    const history = JSON.parse((await call(client, "get_task_activity", { key: "SPI-1" })).text) as {
      action: string;
      via: string;
      changes: Record<string, unknown>;
    }[];
    expect(history[0]).toMatchObject({ action: "task.created", via: "mcp" });
    expect(history.some((e) => e.action === "task.updated" && Array.isArray(e.changes.status))).toBe(true);
    expect(history.at(-1)).toMatchObject({ action: "comment.created", via: "mcp" });

    expect(JSON.parse((await call(client, "mark_inbox_read", { up_to: mention?.id })).text)).toMatchObject({
      updated: expect.any(Number),
    });
    expect(JSON.parse((await call(client, "get_inbox", {})).text)).toEqual([]);
  });

  test("document comments (ST-118): the agent reviews a fragment, the author is notified, replies reach the agent", async () => {
    const owner = ownerCtxs[0];
    if (!owner) throw new Error("no owner");
    const doc = await createDocument(db, owner, { title: "Review me", project: "SPI", content: "# Plan\n\nMigrate the **database** first." });

    const review = await call(client, "add_document_comment", { id: doc.id, body: "Risky order", quote: "Migrate the database first" });
    expect(review.isError).toBeFalsy();
    const comment = review.json() as { id: string };
    expect(comment).toMatchObject({ documentId: doc.id, quote: "Migrate the database first", outdated: false, author: "claude-code", resolver: null });
    expect((await listInbox(db, owner, { kinds: "document_comment" })).map((i) => i.comment?.id)).toEqual([comment.id]);
    const bad = await call(client, "add_document_comment", { id: doc.id, body: "?", quote: "not there" });
    expect(bad).toMatchObject({ isError: true, text: "The quoted text isn't in the document's current version" });

    await addDocumentComment(db, owner, doc.id, { body: "@claude-code what order then?", parentId: comment.id });
    const inbox = JSON.parse((await call(client, "get_inbox", { wait_seconds: 2 })).text) as Record<string, unknown>[];
    expect(inbox.find((i) => i.kind === "document_mention")).toMatchObject({
      project: "SPI",
      document: { id: doc.id, title: "Review me", url: expect.stringContaining(doc.id) },
      comment: { body: "@claude-code what order then?" },
    });

    const resolved = await call(client, "resolve_document_comment", { id: doc.id, comment_id: comment.id });
    expect(resolved.json()).toMatchObject({ resolvedAt: expect.any(String), resolver: "claude-code" });
    const thread = (await call(client, "list_document_comments", { id: doc.id })).json() as { items: { author: string }[] };
    expect(thread.items.map((c) => c.author)).toEqual(["claude-code", expect.any(String)]);
    // Another organization's agent can't see it.
    expect((await call(otherClient, "list_document_comments", { id: doc.id })).isError).toBe(true);
    await call(client, "mark_inbox_read", { up_to: 1_000_000_000 });
  });

  test("unknown statuses and handles are tool errors that list the valid options", async () => {
    const badStatus = await call(client, "update_task", { key: "SPI-1", status: "Shipped" });
    expect(badStatus.isError).toBe(true);
    expect(badStatus.text).toContain("In Review");

    const badHandle = await call(client, "update_task", { key: "SPI-1", assignees: ["nobody"] });
    expect(badHandle.isError).toBe(true);
    expect(badHandle.text).toContain("claude-code");

    const missing = await call(client, "get_task", { key: "SPI-999" });
    expect(missing).toMatchObject({ isError: true, text: "Task SPI-999 not found" });
  });

  test("projects: an agent acts with its owner's rights; a member's agent is refused", async () => {
    const owner = ownerCtxs[0];
    if (!owner) throw new Error("no owner");
    await db.update(schema.actors).set({ role: "member" }).where(eq(schema.actors.id, owner.actorId));
    try {
      const refused = await call(client, "create_project", { key: "OPS", name: "Ops" });
      expect(refused).toMatchObject({ isError: true, text: "Your role can't create projects" });
    } finally {
      await db.update(schema.actors).set({ role: "owner" }).where(eq(schema.actors.id, owner.actorId));
    }

    expect((await call(client, "create_project", { key: "ops", name: "Ops", description: "Runbooks" })).json()).toMatchObject({
      key: "OPS",
      name: "Ops",
      description: "Runbooks",
      archivedAt: null,
      statuses: ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"].map((name) => ({ name })),
    });
    const updated = await call(client, "update_project", { projectKey: "OPS", name: "Operations", description: null });
    expect(updated.json()).toMatchObject({ name: "Operations", description: null });
    expect((await call(client, "archive_project", { projectKey: "OPS" })).json()).toMatchObject({ archivedAt: expect.any(String) });
    expect((await call(client, "list_projects")).json()).toEqual({
      items: [
        {
          id: expect.any(String),
          key: "SPI",
          name: "Spider",
          description: null,
          createdAt: expect.any(String),
          archivedAt: null,
          rulesDocumentId: null,
          url: `${env.WEB_ORIGIN}/${slugs[0] ?? ""}/projects/SPI`,
        },
      ],
    });
    expect((await call(client, "get_project", { projectKey: "OPS" })).json()).toMatchObject({ archivedAt: expect.any(String) });
    expect(await call(client, "create_task", { projectKey: "OPS", title: "x" })).toMatchObject({
      isError: true,
      text: "Project OPS is archived",
    });
    expect((await call(client, "archive_project", { projectKey: "OPS", undo: true })).json()).toMatchObject({ archivedAt: null });
    expect((await call(client, "archive_project", { projectKey: "OPS" })).json()).toMatchObject({ archivedAt: expect.any(String) });
  });

  test("projects: a project-scoped agent gets access to the project it creates", async () => {
    const agentId = agentIds[0] ?? "";
    const [spi] = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.orgId, ownerCtxs[0]?.orgId ?? ""), eq(schema.projects.key, "SPI")));
    await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, agentId));
    await db.insert(schema.agentProjects).values({ agentId, projectId: spi?.id ?? "" });
    try {
      expect((await call(client, "create_project", { key: "SCP", name: "Scoped" })).json()).toMatchObject({ key: "SCP" });
      expect((await call(client, "get_project", { projectKey: "SCP" })).json()).toMatchObject({ key: "SCP" });
      expect((await call(client, "create_task", { projectKey: "SCP", title: "First" })).json()).toMatchObject({ key: "SCP-1" });
      expect((await call(client, "archive_project", { projectKey: "SCP" })).json()).toMatchObject({ archivedAt: expect.any(String) });
    } finally {
      await db.delete(schema.agentProjects).where(eq(schema.agentProjects.agentId, agentId));
      await db.update(schema.agents).set({ scoped: false }).where(eq(schema.agents.actorId, agentId));
    }
  });

  test("a deleted agent stays shown as a deactivated assignee but can't be assigned", async () => {
    const ctx = ownerCtxs[0];
    if (!ctx) throw new Error("no owner");
    const { actor: gone } = await createAgent(db, ctx, { name: "Gone", handle: "gone" });
    const task = await createTask(db, ctx, "SPI", { title: "Orphaned", assigneeIds: [gone.id] });
    await deleteAgent(db, ctx, gone.id);

    expect((await call(client, "get_task", { key: task.key })).json()).toMatchObject({ assignees: ["gone (deactivated)"] });
    const reassigned = await call(client, "update_task", { key: task.key, assignees: ["gone"] });
    expect(reassigned.isError).toBe(true);
    expect(reassigned.text).toBe('Unknown member "gone". Valid handles: me, claude-code, owner-0');
    expect((await call(client, "list_members")).text).not.toContain("gone");

    // Orphaned assignments can still be found by the deactivated handle (ST-65).
    const orphaned = await call(client, "list_tasks", { projectKey: "SPI", assignee: "@gone" });
    expect(orphaned.json()).toMatchObject({ total: 1, items: [{ key: task.key, assignees: ["gone (deactivated)"] }] });
  });

  test('assignee "mine": the agent\'s owner and all the owner\'s agents, deleted ones too', async () => {
    const ctx = ownerCtxs[0];
    if (!ctx) throw new Error("no owner");
    const { actor: sibling } = await createAgent(db, ctx, { name: "Sibling", handle: "sibling" });
    await createTask(db, ctx, "SPI", { title: "mine-check owner", assigneeIds: [ctx.actorId] });
    await createTask(db, ctx, "SPI", { title: "mine-check sibling", assigneeIds: [sibling.id] });
    await createTask(db, ctx, "SPI", { title: "mine-check nobody" });
    const titles = async (assignee: unknown, query: string) =>
      ((await call(client, "list_tasks", { projectKey: "SPI", assignee, query })).json() as { items: { title: string }[] }).items
        .map((t) => t.title)
        .sort();
    expect(await titles("mine", "mine-check")).toEqual(["mine-check owner", "mine-check sibling"]);
    expect(await titles(["@MINE", "none"], "mine-check")).toEqual(["mine-check nobody", "mine-check owner", "mine-check sibling"]);
    expect(await titles("mine", "Orphaned")).toEqual(["Orphaned"]);
    expect(await titles("me", "mine-check")).toEqual([]);
  });

  test("project rules (ST-111): in the server instructions, whoami and get_project; changes reach the inbox", async () => {
    const owner = ownerCtxs[1];
    if (!owner) throw new Error("no owner");
    expect((await call(otherClient, "whoami")).json()).toMatchObject({ projectRules: [] });
    expect((await call(otherClient, "get_project", { projectKey: "SPI" })).json()).toMatchObject({ rules: null });

    const doc = await createDocument(db, owner, { title: "Agent rules", project: "SPI", content: "Finished reviews go to Done." });
    await updateProject(db, owner, "SPI", { rulesDocumentId: doc.id });

    // A new session gets them with its first answer (initialize), without calling anything.
    const fresh = await connect(secrets[1] ?? "");
    try {
      const instructions = fresh.getInstructions() ?? "";
      expect(instructions).toContain("Rules of project SPI (Spider)");
      expect(instructions).toContain("Finished reviews go to Done.");
    } finally {
      await fresh.close();
    }
    // Without rules there are no instructions.
    expect(client.getInstructions()).toBeUndefined();

    // ProjectRulesDto with the document's url, as `spider project view --json` (ST-107).
    const rules = {
      projectKey: "SPI",
      projectName: "Spider",
      documentId: doc.id,
      title: "Agent rules",
      format: "md",
      version: 1,
      content: "Finished reviews go to Done.",
      url: expect.stringContaining(`/docs/${doc.id}`),
    };
    expect((await call(otherClient, "whoami")).json()).toMatchObject({ projectRules: [rules] });
    expect((await call(otherClient, "get_project", { projectKey: "SPI" })).json()).toMatchObject({
      rulesDocumentId: doc.id,
      rules,
    });
    expect(JSON.parse((await call(otherClient, "get_inbox", {})).text)).toEqual([
      expect.objectContaining({
        kind: "rules",
        project: "SPI",
        rulesDocument: { id: doc.id, title: "Agent rules", url: expect.stringContaining(`/docs/${doc.id}`) },
      }),
    ]);

    // The owner's agent can change them through update_project; a non-document id is a tool error.
    expect((await call(otherClient, "update_project", { projectKey: "SPI", rulesDocumentId: null })).json()).toMatchObject({
      rulesDocumentId: null,
    });
    expect(await call(otherClient, "update_project", { projectKey: "SPI", rulesDocumentId: "nope" })).toMatchObject({
      isError: true,
    });
  });

  test("a key from another organization can't see this one's tasks", async () => {
    expect(await call(otherClient, "get_task", { key: "SPI-1" })).toMatchObject({ isError: true });
    expect((await call(otherClient, "list_tasks", { projectKey: "SPI" })).json()).toMatchObject({ total: 0 });
    expect((await call(otherClient, "whoami")).json()).toMatchObject({ organization: { slug: slugs[1] } });
  });
});
