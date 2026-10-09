import { afterAll, describe, expect, test } from "bun:test";
import type { MeResponse, MembershipDto } from "@repo/core";
import { createDb, schema } from "@repo/db";
import { SpiderApiError, createClient } from "@repo/sdk";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import type { Mailer } from "./mailer";

const databaseUrl = process.env.TEST_DATABASE_URL;

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
});

const sentLinks = new Map<string, string>();
const mailer: Mailer = {
  async sendMagicLink(email, url) {
    sentLinks.set(email, url);
  },
};

const db = createDb(env.DATABASE_URL);
const app = createApp({ db, auth: createAuth(db, env, mailer), env });

afterAll(() => db.$client.end());

describe("public routes", () => {
  test("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /auth/providers lists only configured sign-in methods", async () => {
    const res = await app.request("/auth/providers");
    expect(await res.json()).toEqual({ providers: ["magic-link"] });
  });

  test("Batele ID is listed when its client ID is set", async () => {
    const withBatele = loadEnv({ ...env, PORT: String(env.PORT), BATELE_ID_CLIENT_ID: "oc_test" });
    const appWithBatele = createApp({ db, auth: createAuth(db, withBatele, mailer), env: withBatele });
    const res = await appWithBatele.request("/auth/providers");
    expect(await res.json()).toEqual({ providers: ["magic-link", "batele-id"] });
  });

  test("GET /openapi.json describes the public API", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, { required?: string[] }> };
    };
    expect(doc.openapi).toStartWith("3.1");
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.components.schemas.CreateTaskInput?.required).toEqual(["title"]);

    // Every documented operation is a real route.
    const routes = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item).filter((k) => k !== "parameters")) {
        expect(routes).toContain(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
      }
    }
  });

  test("/v1 requires a session", async () => {
    const res = await app.request("/v1/me");
    expect(res.status).toBe(401);
  });

  test("CORS allows only the web origin, with credentials", async () => {
    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: { Origin: env.WEB_ORIGIN, "Access-Control-Request-Method": "GET" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(env.WEB_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

const withDb = databaseUrl ? describe : describe.skip;

withDb("magic link sign-in → organization", () => {
  const email = `e2e-${Date.now()}@example.com`;
  const slug = `e2e-${Date.now()}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("signs in, creates an organization and lists it", async () => {
    const send = await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    expect(send.status).toBe(200);

    const link = sentLinks.get(email);
    expect(link).toBeDefined();
    const verifyUrl = new URL(link ?? "");
    const verify = await app.request(verifyUrl.pathname + verifyUrl.search, { redirect: "manual" });
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toStartWith(env.WEB_ORIGIN);

    const cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("session_token");

    const before = await app.request("/v1/me", { headers: { Cookie: cookie } });
    expect(before.status).toBe(200);
    const me = (await before.json()) as MeResponse;
    expect(me.user.email).toBe(email);
    expect(me.memberships).toEqual([]);

    const create = await app.request("/v1/organizations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Org", slug }),
    });
    expect(create.status).toBe(201);
    const membership = (await create.json()) as MembershipDto;
    expect(membership.actor.role).toBe("owner");

    const duplicate = await app.request("/v1/organizations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Again", slug }),
    });
    expect(duplicate.status).toBe(409);

    const after = (await (await app.request("/v1/me", { headers: { Cookie: cookie } })).json()) as MeResponse;
    expect(after.memberships.map((m) => m.organization.slug)).toEqual([slug]);
  });
});

async function signIn(email: string): Promise<string> {
  await app.request("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
    body: JSON.stringify({ email, callbackURL: `${env.WEB_ORIGIN}/` }),
  });
  const link = new URL(sentLinks.get(email) ?? "");
  const verify = await app.request(link.pathname + link.search, { redirect: "manual" });
  return verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

withDb("projects and tasks API", () => {
  const stamp = Date.now();
  const ownerEmail = `owner-${stamp}@example.com`;
  const outsiderEmail = `outsider-${stamp}@example.com`;
  const slug = `api-${stamp}`;
  let owner = "";
  let outsider = "";

  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(`/v1/orgs/${slug}${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const email of [ownerEmail, outsiderEmail]) await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("project → tasks → move → delete", async () => {
    owner = await signIn(ownerEmail);
    outsider = await signIn(outsiderEmail);
    await app.request("/v1/organizations", {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "API Org", slug }),
    });

    const project = await call(owner, "POST", "/projects", { name: "Spider", key: "SPI" });
    expect(project.status).toBe(201);
    const { statuses } = (await project.json()) as { statuses: { id: string; category: string }[] };
    const done = statuses.find((s) => s.category === "done")?.id;

    const members = (await (await call(owner, "GET", "/members")).json()) as { items: { id: string }[] };
    const created = await call(owner, "POST", "/projects/SPI/tasks", {
      title: "Ship it",
      assigneeIds: [members.items[0]?.id],
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ key: "SPI-1", title: "Ship it" });

    const invalid = await call(owner, "POST", "/projects/SPI/tasks", { title: "" });
    expect(invalid.status).toBe(400);

    const moved = await call(owner, "PATCH", "/tasks/SPI-1", { statusId: done });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { completedAt: string | null }).completedAt).not.toBeNull();

    const tasks = (await (await call(owner, "GET", "/projects/SPI/tasks")).json()) as { items: unknown[] };
    expect(tasks.items).toHaveLength(1);

    expect((await call(owner, "DELETE", "/tasks/SPI-1")).status).toBe(204);
    expect((await call(owner, "GET", "/tasks/SPI-1")).status).toBe(404);
  });

  test("non-members get 404 for the whole organization", async () => {
    expect((await call(outsider, "GET", "/projects")).status).toBe(404);
    expect((await call(outsider, "POST", "/projects", { name: "x", key: "XX" })).status).toBe(404);
  });
});

withDb("agent API keys", () => {
  const stamp = Date.now();
  const ownerEmail = `keys-owner-${stamp}@example.com`;
  const slug = `keys-${stamp}`;
  const otherSlug = `keys-other-${stamp}`;

  afterAll(async () => {
    for (const s of [slug, otherSlug]) await db.delete(schema.organizations).where(eq(schema.organizations.slug, s));
    await db.delete(schema.user).where(eq(schema.user.email, ownerEmail));
  });

  test("an agent key works inside its organization only", async () => {
    const owner = await signIn(ownerEmail);
    const asOwner = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { Cookie: owner, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    for (const s of [slug, otherSlug]) await asOwner("POST", "/v1/organizations", { name: s, slug: s });
    await asOwner("POST", `/v1/orgs/${slug}/projects`, { name: "Spider", key: "SPI" });

    const agentRes = await asOwner("POST", `/v1/orgs/${slug}/agents`, { name: "Claude Code" });
    expect(agentRes.status).toBe(201);
    const agent = (await agentRes.json()) as { actor: { id: string; type: string } };
    expect(agent.actor.type).toBe("agent");

    const keyRes = await asOwner("POST", `/v1/orgs/${slug}/agents/${agent.actor.id}/keys`, { name: "test" });
    expect(keyRes.status).toBe(201);
    const { secret, key } = (await keyRes.json()) as { secret: string; key: { id: string } };

    const asAgent = (method: string, path: string, body?: unknown, token = secret) =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const who = (await (await asAgent("GET", "/v1/whoami")).json()) as { actor: { id: string } };
    expect(who.actor.id).toBe(agent.actor.id);

    const task = await asAgent("POST", `/v1/orgs/${slug}/projects/SPI/tasks`, { title: "From an agent" });
    expect(task.status).toBe(201);
    expect(((await task.json()) as { creatorId: string }).creatorId).toBe(agent.actor.id);
    const log = await db.select().from(schema.activity).where(eq(schema.activity.actorId, agent.actor.id));
    expect(log.map((e) => e.source)).toEqual(["api"]);

    expect((await asAgent("GET", `/v1/orgs/${otherSlug}/projects`)).status).toBe(404);
    expect((await asAgent("POST", `/v1/orgs/${slug}/agents`, { name: "Sneaky" })).status).toBe(403);
    expect((await asAgent("GET", "/v1/me")).status).toBe(403);
    expect((await asAgent("POST", "/v1/organizations", { name: "x", slug: `x-${stamp}` })).status).toBe(403);
    expect((await asAgent("GET", "/v1/whoami", undefined, "spt_wrong")).status).toBe(401);

    expect((await asOwner("DELETE", `/v1/orgs/${slug}/api-keys/${key.id}`)).status).toBe(204);
    expect((await asAgent("GET", `/v1/orgs/${slug}/projects`)).status).toBe(401);
  });
});

withDb("SDK and client-declared source", () => {
  const stamp = Date.now();
  const ownerEmail = `sdk-owner-${stamp}@example.com`;
  const slug = `sdk-${stamp}`;
  let secret = "";
  let agentId = "";

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, ownerEmail));
  });

  // Drives the SDK straight into the Hono app, no network involved.
  const sdk = (options: { token?: string; source?: "api" | "cli" | "mcp" } = {}) =>
    createClient({ baseUrl: env.API_ORIGIN, token: secret, ...options, fetch: (input, init) => app.request(input, init) });

  test("owner sets up an agent with a key", async () => {
    const owner = await signIn(ownerEmail);
    const asOwner = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { Cookie: owner, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await asOwner("/v1/organizations", { name: "SDK Org", slug });
    await asOwner(`/v1/orgs/${slug}/projects`, { name: "Spider", key: "SPI" });
    const agent = (await (await asOwner(`/v1/orgs/${slug}/agents`, { name: "SDK Bot" })).json()) as {
      actor: { id: string };
    };
    agentId = agent.actor.id;
    const key = (await (await asOwner(`/v1/orgs/${slug}/agents/${agentId}/keys`, { name: "sdk" })).json()) as {
      secret: string;
    };
    secret = key.secret;
    expect(secret).toStartWith("spt_");
  });

  test("the SDK covers whoami, projects and the task lifecycle", async () => {
    const client = sdk();
    const who = await client.whoami();
    expect(who.actor.id).toBe(agentId);
    expect(who.organization.slug).toBe(slug);

    const projects = await client.projects.list(slug);
    expect(projects.items.map((p) => p.key)).toEqual(["SPI"]);
    const project = await client.projects.get(slug, "SPI");
    const done = project.statuses.find((s) => s.category === "done");

    const members = await client.members.list(slug);
    expect(members.items.map((m) => m.id)).toContain(agentId);

    const created = await client.tasks.create(slug, "SPI", { title: "Via SDK", assigneeIds: [agentId] });
    expect(created).toMatchObject({ key: "SPI-1", title: "Via SDK", creatorId: agentId, assigneeIds: [agentId] });

    const updated = await client.tasks.update(slug, created.key, { title: "Via SDK, done", statusId: done?.id });
    expect(updated.completedAt).not.toBeNull();
    expect((await client.tasks.get(slug, created.key)).title).toBe("Via SDK, done");
    expect((await client.tasks.list(slug, "SPI")).items).toHaveLength(1);

    expect(await client.tasks.delete(slug, created.key)).toBeUndefined();
    const error = await client.tasks.get(slug, created.key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpiderApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });

  test("API-key clients declare their source; unknown values fall back to api", async () => {
    const cli = await sdk({ source: "cli" }).tasks.create(slug, "SPI", { title: "From the CLI" });
    const raw = await app.request(`/v1/orgs/${slug}/projects/SPI/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "X-Spider-Source": "ui", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Claims to be the UI" }),
    });
    expect(raw.status).toBe(201);
    const spoofed = (await raw.json()) as { id: string };

    const log = await db.select().from(schema.activity).where(eq(schema.activity.actorId, agentId));
    const sourceOf = (taskId: string) => log.find((e) => e.entityId === taskId)?.source;
    expect(sourceOf(cli.id)).toBe("cli");
    expect(sourceOf(spoofed.id)).toBe("api");
  });
});
