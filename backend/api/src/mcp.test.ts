import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ActorContext } from "@repo/core";
import { createAgent, createApiKey, createOrganization, createProject } from "@repo/core";
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
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    const agent = await createAgent(db, ctx, { name: "Claude Code" });
    return (await createApiKey(db, ctx, agent.actor.id, { name: "test" })).secret;
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
        "assign_to_me",
        "create_task",
        "get_project",
        "get_task",
        "list_members",
        "list_projects",
        "list_tasks",
        "start_task",
        "update_task",
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
    expect(created.json()).toMatchObject({ key: "SPI-1", status: "Todo", priority: "high", assignees: ["owner-0"] });

    const started = await call(client, "start_task", { key: "SPI-1" });
    expect(started.json()).toMatchObject({ status: "In Progress", assignees: ["owner-0", "claude-code"] });

    const task = await call(client, "get_task", { key: "spi-1" });
    expect(task.json()).toMatchObject({ key: "SPI-1", title: "Wire up MCP", status: "In Progress", creator: "claude-code" });

    const mine = await call(client, "list_tasks", { projectKey: "SPI", assignee: "me", status: "in progress" });
    expect(mine.json()).toMatchObject({ total: 1, tasks: [{ key: "SPI-1" }] });
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

  test("a key from another organization can't see this one's tasks", async () => {
    expect(await call(otherClient, "get_task", { key: "SPI-1" })).toMatchObject({ isError: true });
    expect((await call(otherClient, "list_tasks", { projectKey: "SPI" })).json()).toMatchObject({ total: 0 });
    expect((await call(otherClient, "whoami")).json()).toMatchObject({ organization: { slug: slugs[1] } });
  });
});
