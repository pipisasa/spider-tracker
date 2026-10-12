import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AcceptedAgentInviteDto, ActorContext } from "@repo/core";
import {
  createAgentInvite,
  createOrganization,
  createProject,
  createTask,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { createClient, SpiderApiError } from "@repo/sdk";
import { eq } from "drizzle-orm";
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
  TRUSTED_PROXY: "railway",
});

const db = createDb(env.DATABASE_URL);
const app = createApp({
  db,
  auth: createAuth(db, env, { async sendMagicLink() {} }),
  env,
});

afterAll(() => db.$client.end());

const accept = (body: unknown, ip = "203.0.113.1") =>
  app.request("/v1/agent-invites/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });

test("accepting is rate limited per client IP", async () => {
  // An empty code fails validation before any database lookup, so this runs without TEST_DATABASE_URL.
  const ip = "198.51.100.7";
  for (let i = 0; i < 10; i++)
    expect((await accept({ code: "" }, ip)).status).toBe(400);
  const limited = await accept({ code: "" }, ip);
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({
    error: { code: "rate_limited" },
  });
  expect((await accept({ code: "" }, "198.51.100.8")).status).toBe(400);
});

const withDb = databaseUrl ? describe : describe.skip;

withDb("agent invites over HTTP", () => {
  const slug = `agent-invites-api-${Date.now()}`;
  const userId = `test-${crypto.randomUUID()}`;
  let owner: ActorContext;
  let accepted: AcceptedAgentInviteDto;

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const { organization, actor } = await createOrganization(
      db,
      { id: userId, name: "Owner", email: "owner@example.com" },
      { name: "Invite API Org", slug },
    );
    owner = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Secret", key: "XY" });
    await createTask(db, owner, "ST", { title: "Visible" });
    await createTask(db, owner, "XY", { title: "Hidden" });
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  test("POST /v1/agent-invites/accept needs no session and returns the key and scope", async () => {
    const { invite } = await createAgentInvite(db, owner, {
      projectKeys: ["ST"],
    });
    const res = await accept({
      code: `${env.WEB_ORIGIN}/agent-invite/${invite.code}`,
      name: "Scoped Bot",
    });
    expect(res.status).toBe(201);
    accepted = (await res.json()) as AcceptedAgentInviteDto;
    expect(accepted).toMatchObject({
      actor: { type: "agent", name: "Scoped Bot", handle: "scoped-bot" },
      organization: { slug, name: "Invite API Org" },
      projects: [{ key: "ST", name: "Spider" }],
      owner: { id: owner.actorId, name: "Owner" },
    });
    expect(accepted.token).toStartWith("spt_");

    const again = await accept({ code: invite.code });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({
      error: { message: "Invalid or expired invitation code" },
    });
  });

  test("the agent updates itself and sees only its projects", async () => {
    const sdk = createClient({
      baseUrl: env.API_ORIGIN,
      token: accepted.token,
      fetch: (input, init) => app.request(input, init),
    });
    const me = await sdk.agents.updateMe(slug, {
      description: "Works on ST",
      handle: "scoped",
    });
    expect(me).toMatchObject({
      actor: { handle: "scoped" },
      description: "Works on ST",
      projects: [{ key: "ST" }],
    });

    expect((await sdk.projects.list(slug)).items.map((p) => p.key)).toEqual([
      "ST",
    ]);
    // Out of scope is not found, filtered or not; in scope, filters work.
    for (const query of [{}, { status: ["todo"] }, { tags: ["nope"] }]) {
      expect(await sdk.tasks.list(slug, "XY", query).catch((e: unknown) => e)).toMatchObject({ status: 404 });
    }
    expect((await sdk.tasks.list(slug, "ST", { q: "visible", assignee: ["none"] })).items.map((t) => t.title)).toEqual([
      "Visible",
    ]);
    const missing = await sdk.tasks.get(slug, "XY-1").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(SpiderApiError);
    expect(missing).toMatchObject({ status: 404 });
    const update = await sdk.tasks
      .update(slug, "XY-1", { title: "Nope" })
      .catch((e: unknown) => e);
    expect(update).toMatchObject({ status: 404 });
    expect((await sdk.tasks.get(slug, "ST-1")).title).toBe("Visible");
  });

  test("MCP tools respect the scope", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${env.API_ORIGIN}/mcp`),
      {
        fetch: async (url, init) => app.request(url, init),
        requestInit: { headers: { Authorization: `Bearer ${accepted.token}` } },
      },
    );
    const client = new Client({ name: "spider-test", version: "0.0.0" });
    await client.connect(transport);
    type ToolText = { content: { text: string }[]; isError?: boolean };
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolText;

    const projects = await call("list_projects");
    expect(JSON.parse(projects.content[0]?.text ?? "[]")).toEqual([
      { key: "ST", name: "Spider", description: null, url: expect.stringMatching(/\/projects\/ST$/) },
    ]);
    const hidden = await call("list_tasks", { projectKey: "XY" });
    expect(hidden.isError).toBe(true);
    expect((await call("get_task", { key: "XY-1" })).isError).toBe(true);
    expect((await call("get_task", { key: "ST-1" })).isError).toBeFalsy();
    await client.close();
  });
});
