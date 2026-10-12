import { afterAll, describe, expect, test } from "bun:test";
import { MIN_CLI_VERSION, type MeResponse, type MembershipDto } from "@repo/core";
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
    expect(await res.json()).toEqual({ status: "ok", minCliVersion: MIN_CLI_VERSION });
  });

  test("/v1 responses carry the oldest supported CLI version, errors included", async () => {
    // No credentials: refused before any database lookup, so this runs without TEST_DATABASE_URL.
    const res = await app.request("/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Spider-Min-Cli")).toBe(MIN_CLI_VERSION);
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

    // Every documented operation is a real route, and every route is documented.
    const routes = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((k) => k !== "parameters")
          .map((method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`),
      ),
    );
    for (const operation of documented) expect(routes).toContain(operation);
    // Infrastructure that has its own protocol or spec.
    const undocumented = new Set([
      "GET /openapi.json",
      "GET /swagger",
      "GET /scalar",
      "GET /api/auth/*",
      "POST /api/auth/*",
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);
    const missing = app.routes
      .filter((r) => r.method !== "ALL") // middleware registered with app.use
      .map((r) => `${r.method} ${r.path}`)
      .filter((route) => !documented.has(route) && !undocumented.has(route));
    expect([...new Set(missing)]).toEqual([]);
  });

  test.each([
    ["/swagger", "swagger-ui-dist@", "SwaggerUIBundle"],
    ["/scalar", "@scalar/api-reference@", "Scalar.createApiReference"],
  ])("GET %s serves an API reference page for /openapi.json", async (path, asset, bootstrap) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("text/html");
    const html = await res.text();
    expect(html).toContain('"/openapi.json"');
    expect(html).toContain(`https://cdn.jsdelivr.net/npm/${asset}`);
    expect(html).toContain(bootstrap);
    // Every CDN asset is pinned and integrity-checked.
    const external = html.match(/(?:src|href)="https:[^"]+"[^>]*/g) ?? [];
    expect(external.length).toBeGreaterThan(0);
    for (const tag of external) expect(tag).toMatch(/@\d+\.\d+\.\d+\/.*integrity="sha384-/);
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

    const history = await call(owner, "GET", "/tasks/SPI-1/activity");
    expect(history.status).toBe(200);
    const { items: activity } = (await history.json()) as {
      items: { id: number; action: string; source: string; changes: Record<string, unknown> | null }[];
    };
    expect(activity.map((a) => a.action)).toEqual(["task.created", "task.updated"]);
    expect(activity[1]?.changes?.statusId).toEqual([expect.any(String), done]);
    expect(activity[0]?.source).toBe("ui");
    expect((activity[0]?.id ?? 0) < (activity[1]?.id ?? 0)).toBe(true);
    expect((await call(outsider, "GET", "/tasks/SPI-1/activity")).status).toBe(404);

    const tag = (await (await call(owner, "POST", "/tags", { name: "Urgent-fix", color: "#ef4444" })).json()) as { id: string };
    await call(owner, "PATCH", "/tasks/SPI-1", { tagIds: [tag.id], priority: 1 });
    const count = async (query: string) => {
      const res = await call(owner, "GET", `/projects/SPI/tasks?${query}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: unknown[] }).items.length;
    };
    expect(await count("tag=urgent-FIX&priority=1&priority=2")).toBe(1);
    expect(await count("priority=2&priority=3")).toBe(0);
    expect(await count("status=done&assignee=me&q=ship")).toBe(1);
    expect(await count("assignee=none")).toBe(0);
    expect((await call(owner, "GET", "/projects/SPI/tasks?tag=nope")).status).toBe(400);
    expect((await call(owner, "GET", "/projects/SPI/tasks?priority=9")).status).toBe(400);

    expect((await call(owner, "DELETE", "/tasks/SPI-1")).status).toBe(204);
    expect((await call(owner, "GET", "/tasks/SPI-1")).status).toBe(404);
  });

  test("non-members get 404 for the whole organization", async () => {
    expect((await call(outsider, "GET", "/projects")).status).toBe(404);
    expect((await call(outsider, "POST", "/projects", { name: "x", key: "XX" })).status).toBe(404);
  });

  test("malformed ids are a 404, not a 500", async () => {
    const res = await call(owner, "DELETE", "/tags/not-a-uuid");
    expect(res.status).toBe(404);
  });

  test("update, archive and restore a project", async () => {
    const updated = await call(owner, "PATCH", "/projects/spi", { name: "Spider Tracker", description: "The tracker" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      key: "SPI",
      name: "Spider Tracker",
      description: "The tracker",
      archivedAt: null,
    });
    expect((await call(owner, "PATCH", "/projects/SPI", {})).status).toBe(400);

    const archived = await call(owner, "POST", "/projects/SPI/archive");
    expect(((await archived.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const keys = async (path: string) =>
      ((await (await call(owner, "GET", path)).json()) as { items: { key: string }[] }).items.map((p) => p.key);
    expect(await keys("/projects")).toEqual([]);
    expect(await keys("/projects?archived=true")).toEqual(["SPI"]);
    expect((await call(owner, "POST", "/projects/SPI/tasks", { title: "Too late" })).status).toBe(400);

    const restored = await call(owner, "DELETE", "/projects/SPI/archive");
    expect(await restored.json()).toMatchObject({ key: "SPI", archivedAt: null });
    expect(await keys("/projects")).toEqual(["SPI"]);
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
    expect((await client.tasks.list(slug, "SPI", { status: ["done"], assignee: ["me"], priority: [0, 1] })).items).toHaveLength(1);
    expect((await client.tasks.list(slug, "SPI", { priority: [4], q: "SDK" })).items).toHaveLength(0);

    expect(await client.tasks.delete(slug, created.key)).toBeUndefined();
    const error = await client.tasks.get(slug, created.key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpiderApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });

  test("documents through the SDK: create, list, save with baseVersion, 409 on a stale save, versions", async () => {
    const client = sdk();
    const doc = await client.documents.create(slug, { title: "Spec", project: "SPI", content: "v1" });
    expect(doc).toMatchObject({ projectKey: "SPI", version: 1 });
    expect((await client.documents.list(slug, { project: "SPI" })).items.map((d) => d.id)).toEqual([doc.id]);

    const saved = await client.documents.update(slug, doc.id, { baseVersion: 1, content: "v2" });
    expect(saved.version).toBe(2);
    const stale = await client.documents.update(slug, doc.id, { baseVersion: 1, content: "lost" }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ status: 409, code: "conflict" });

    expect((await client.documents.versions.list(slug, doc.id)).items.map((v) => v.version)).toEqual([2, 1]);
    expect((await client.documents.versions.get(slug, doc.id, 1)).content).toBe("v1");
    await client.documents.delete(slug, doc.id);
    expect(await client.documents.get(slug, doc.id).catch((e: unknown) => e)).toMatchObject({ status: 404 });
  });

  test("POST /documents/:id/move makes a document organization-wide and back, keeping its versions", async () => {
    const client = sdk();
    const doc = await client.documents.create(slug, { title: "Movable", project: "SPI", content: "v1" });
    await client.documents.update(slug, doc.id, { baseVersion: 1, content: "v2" });
    expect(await client.documents.move(slug, doc.id, { project: null })).toMatchObject({ id: doc.id, projectKey: null, version: 2 });
    expect(await client.documents.move(slug, doc.id, { project: "SPI" })).toMatchObject({ projectKey: "SPI", content: "v2" });
    expect((await client.documents.versions.list(slug, doc.id)).items).toHaveLength(2);
    expect(await client.documents.move(slug, doc.id, { project: "NOPE" }).catch((e: unknown) => e)).toMatchObject({ status: 404 });
    await client.documents.delete(slug, doc.id);
  });

  test("saved views through the SDK: create, list, rename, delete; bad filters are a 400", async () => {
    const client = sdk();
    const view = await client.views.create(slug, "SPI", { name: "Mine", filters: { assignee: ["me"], priority: [1, 2] }, view: "list" });
    expect(view).toMatchObject({ projectKey: "SPI", ownerActorId: agentId, shared: false, view: "list", filters: { assignee: ["me"], priority: [1, 2] } });
    expect((await client.views.list(slug, "SPI")).items.map((v) => v.id)).toEqual([view.id]);
    expect((await client.views.update(slug, "SPI", view.id, { name: "Renamed", shared: true })).name).toBe("Renamed");
    const bad = await client.views.create(slug, "SPI", { name: "Bad", filters: { priority: [7 as 1] } }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 400, code: "validation" });
    expect(await client.views.delete(slug, "SPI", view.id)).toBeUndefined();
    expect((await client.views.list(slug, "SPI")).items).toEqual([]);
    expect(await client.views.list(slug, "NOPE").catch((e: unknown) => e)).toMatchObject({ status: 404 });
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

withDb("agent presence (ST-67)", () => {
  const stamp = Date.now();
  const ownerEmail = `presence-owner-${stamp}@example.com`;
  const slug = `presence-${stamp}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, ownerEmail));
  });

  test("an agent reading a task is working on it; a person reading it is not", async () => {
    const owner = await signIn(ownerEmail);
    const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Cookie: owner }) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await send("POST", "/v1/organizations", { name: "Presence Org", slug });
    await send("POST", `/v1/orgs/${slug}/projects`, { name: "Spider", key: "SPI" });
    const agent = (await (await send("POST", `/v1/orgs/${slug}/agents`, { name: "Watcher" })).json()) as { actor: { id: string } };
    const key = (await (await send("POST", `/v1/orgs/${slug}/agents/${agent.actor.id}/keys`, { name: "k" })).json()) as { secret: string };
    const bearer = { Authorization: `Bearer ${key.secret}` };
    await send("POST", `/v1/orgs/${slug}/projects/SPI/tasks`, { title: "Look at me" });

    const presence = async (headers?: Record<string, string>) =>
      ((await (await send("GET", `/v1/orgs/${slug}/projects/SPI/presence`, undefined, headers)).json()) as {
        items: { taskKey: string; actorId: string; lastSeenAt: string }[];
      }).items;

    expect(await presence()).toEqual([]);
    expect((await send("GET", `/v1/orgs/${slug}/tasks/SPI-1`)).status).toBe(200);
    expect(await presence()).toEqual([]);

    expect((await send("GET", `/v1/orgs/${slug}/tasks/SPI-1`, undefined, bearer)).status).toBe(200);
    const active = await presence();
    expect(active).toMatchObject([{ taskKey: "SPI-1", actorId: agent.actor.id }]);
    expect(Date.now() - Date.parse(active[0]?.lastSeenAt ?? "")).toBeLessThan(10_000);
    // Visible to agents too, through the SDK.
    const client = createClient({ baseUrl: env.API_ORIGIN, token: key.secret, fetch: (input, init) => app.request(input, init) });
    expect((await client.tasks.presence(slug, "SPI")).items).toHaveLength(1);

    expect((await send("GET", `/v1/orgs/${slug}/projects/NOPE/presence`)).status).toBe(404);
  });
});

withDb("device login (spider login)", () => {
  const stamp = Date.now();
  const email = `device-${stamp}@example.com`;
  const slug = `device-${stamp}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("code → browser approval → token → whoami → logout", async () => {
    const cookie = await signIn(email);
    await app.request("/v1/organizations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Device Org", slug }),
    });

    const start = await app.request("/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_name=MacBook",
    });
    const code = (await start.json()) as { device_code: string; user_code: string; verification_uri_complete: string };
    expect(code.verification_uri_complete).toBe(`${env.WEB_ORIGIN}/device?code=${code.user_code}`);

    const token = () =>
      app.request("/device/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code }),
      });
    const pending = await token();
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending" });

    const info = await app.request(`/v1/device/${code.user_code}`, { headers: { Cookie: cookie } });
    expect(await info.json()).toMatchObject({ clientName: "MacBook", status: "pending" });
    const approve = await app.request(`/v1/device/${code.user_code}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: slug }),
    });
    expect(approve.status).toBe(204);

    await db.update(schema.deviceCodes).set({ lastPolledAt: null }).where(eq(schema.deviceCodes.userCode, code.user_code));
    const granted = await token();
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as { access_token: string; actor: { name: string }; organization: { slug: string } };
    expect(body).toMatchObject({ token_type: "Bearer", actor: { name: "spider CLI · MacBook" }, organization: { slug } });

    const bearer = { Authorization: `Bearer ${body.access_token}` };
    expect((await app.request("/v1/whoami", { headers: bearer })).status).toBe(200);
    expect((await app.request("/v1/api-keys/current", { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(403);
    expect((await app.request("/v1/api-keys/current", { method: "DELETE", headers: bearer })).status).toBe(204);
    expect((await app.request("/v1/whoami", { headers: bearer })).status).toBe(401);
  });

  test("an agent key can't approve devices", async () => {
    const start = (await (await app.request("/device/code", { method: "POST" })).json()) as { user_code: string };
    const res = await app.request(`/v1/device/${start.user_code}`, { headers: { Authorization: "Bearer spt_nope" } });
    expect(res.status).toBe(401);
  });
});

withDb("comments and inbox API", () => {
  const stamp = Date.now();
  const email = `inbox-${stamp}@example.com`;
  const slug = `inbox-${stamp}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("a waiting inbox request returns as soon as someone mentions the agent", async () => {
    const cookie = await signIn(email);
    const asOwner = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await asOwner("POST", "/v1/organizations", { name: "Inbox Org", slug });
    await asOwner("POST", `/v1/orgs/${slug}/projects`, { name: "Spider", key: "SPI" });
    await asOwner("POST", `/v1/orgs/${slug}/projects/SPI/tasks`, { title: "Talk to me" });
    const agent = (await (await asOwner("POST", `/v1/orgs/${slug}/agents`, { name: "Claude" })).json()) as {
      actor: { id: string };
    };
    const { secret } = (await (await asOwner("POST", `/v1/orgs/${slug}/agents/${agent.actor.id}/keys`, { name: "t" })).json()) as {
      secret: string;
    };
    const asAgent = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const started = Date.now();
    const waiting = asAgent("GET", `/v1/orgs/${slug}/inbox?wait=10&unread=true`);
    await Bun.sleep(300);
    const posted = await asOwner("POST", `/v1/orgs/${slug}/tasks/SPI-1/comments`, { body: "@claude what's the status?" });
    expect(posted.status).toBe(201);

    const inbox = (await (await waiting).json()) as { items: { id: number; kind: string; comment: { body: string } }[] };
    expect(Date.now() - started).toBeLessThan(5000);
    expect(inbox.items.map((i) => i.kind)).toEqual(["mention"]);
    expect(inbox.items[0]?.comment.body).toContain("status");

    const reply = await asAgent("POST", `/v1/orgs/${slug}/tasks/SPI-1/comments`, { body: "Working on it" });
    expect(reply.status).toBe(201);
    const thread = (await (await asOwner("GET", `/v1/orgs/${slug}/tasks/SPI-1/comments`)).json()) as {
      items: { authorId: string }[];
    };
    expect(thread.items.map((c) => c.authorId).at(-1)).toBe(agent.actor.id);

    const read = await asAgent("POST", `/v1/orgs/${slug}/inbox/read`, { upTo: inbox.items[0]?.id });
    expect(await read.json()).toEqual({ updated: 1 });
    const empty = (await (await asAgent("GET", `/v1/orgs/${slug}/inbox?unread=true`)).json()) as { items: unknown[] };
    expect(empty.items).toEqual([]);

    // The loop guard surfaces as 429.
    for (let i = 0; i < 4; i++) await asAgent("POST", `/v1/orgs/${slug}/tasks/SPI-1/comments`, { body: `note ${i}` });
    expect((await asAgent("POST", `/v1/orgs/${slug}/tasks/SPI-1/comments`, { body: "too much" })).status).toBe(429);
  });
});

withDb("realtime events (SSE)", () => {
  const stamp = Date.now();
  const email = `sse-${stamp}@example.com`;
  const slug = `sse-${stamp}`;
  const otherSlug = `sse-other-${stamp}`;

  afterAll(async () => {
    for (const s of [slug, otherSlug]) await db.delete(schema.organizations).where(eq(schema.organizations.slug, s));
    await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("the stream carries this organization's changes, and nobody else's", async () => {
    const cookie = await signIn(email);
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const s of [slug, otherSlug]) {
      await post("/v1/organizations", { name: s, slug: s });
      await post(`/v1/orgs/${s}/projects`, { name: "Spider", key: "SPI" });
    }

    const controller = new AbortController();
    const res = await app.request(`/v1/orgs/${slug}/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      return buffer.includes(needle);
    };

    expect(await readUntil("event: ready")).toBe(true);
    await post(`/v1/orgs/${otherSlug}/projects/SPI/tasks`, { title: "elsewhere" });
    await post(`/v1/orgs/${slug}/projects/SPI/tasks`, { title: "Live" });
    await post(`/v1/orgs/${slug}/tasks/SPI-1/comments`, { body: "hi" });
    expect(await readUntil("event: comment.created")).toBe(true);

    const events = buffer
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.includes("orgId"))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; taskKey?: string });
    expect(events.map((e) => [e.type, e.taskKey])).toEqual([
      ["task.changed", "SPI-1"],
      ["comment.created", "SPI-1"],
    ]);

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

withDb("sign-up allowlist", () => {
  const stamp = Date.now();
  const allowed = `allowed-${stamp}@example.com`;
  const refused = `refused-${stamp}@example.com`;
  const gated = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: env.DATABASE_URL,
    API_ORIGIN: env.API_ORIGIN,
    WEB_ORIGIN: env.WEB_ORIGIN,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    SIGNUP_ALLOWLIST: `${allowed}, @allowed-domain.test`,
  });
  const links = new Map<string, string>();
  const gatedAuth = createAuth(db, gated, {
    async sendMagicLink(email, url) {
      links.set(email, url);
    },
  });
  const gatedApp = createApp({ db, auth: gatedAuth, env: gated });
  const request = (email: string) =>
    gatedApp.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: gated.WEB_ORIGIN },
      body: JSON.stringify({ email, callbackURL: `${gated.WEB_ORIGIN}/` }),
    });

  afterAll(async () => {
    for (const email of [allowed, refused]) await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  test("refused emails get no link; allowed ones sign up", async () => {
    const res = await request(refused);
    expect(res.status).toBe(200); // Same answer either way: the form doesn't reveal the list.
    expect(links.has(refused)).toBe(false);

    expect((await request(allowed)).status).toBe(200);
    const link = new URL(links.get(allowed) ?? "");
    const verify = await gatedApp.request(link.pathname + link.search, { redirect: "manual" });
    expect(verify.headers.get("location")).toStartWith(gated.WEB_ORIGIN);
    const [user] = await db.select().from(schema.user).where(eq(schema.user.email, allowed));
    expect(user).toBeDefined();
    const [blocked] = await db.select().from(schema.user).where(eq(schema.user.email, refused));
    expect(blocked).toBeUndefined();
  });

  test("the response doesn't wait for the email, and refused addresses trigger no send", async () => {
    const started: string[] = [];
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const slowAuth = createAuth(db, gated, {
      async sendMagicLink(email) {
        started.push(email);
        await released;
      },
    });
    const slowApp = createApp({ db, auth: slowAuth, env: gated });
    const send = (email: string) =>
      slowApp.request("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: gated.WEB_ORIGIN },
        body: JSON.stringify({ email, callbackURL: `${gated.WEB_ORIGIN}/` }),
      });

    // Answers while the mailer is still pending.
    expect((await send(`slow-${stamp}@allowed-domain.test`)).status).toBe(200);
    expect(started).toEqual([`slow-${stamp}@allowed-domain.test`]);

    expect((await send(refused)).status).toBe(200);
    expect(started).toHaveLength(1);
    release();
  });

  test("validateUserInfo refuses new users outside the list, for any sign-in method", async () => {
    const hook = gatedAuth.options.user?.validateUserInfo;
    if (!hook) throw new Error("validateUserInfo is not configured");
    const call = (
      email: string,
      action: "create-user" | "sign-in",
      { emailVerified = false, provider = "batele-id" }: { emailVerified?: boolean; provider?: "batele-id" | "github" | "magic-link" } = {},
    ) =>
      hook({
        user: { email, emailVerified },
        source:
          provider === "magic-link"
            ? { action, method: "magic-link" }
            : { action, method: "oauth", oauth: { providerId: provider } },
      });
    const refusedSignup = { error: "signup_not_allowed" };
    expect(await call("someone@elsewhere.test", "create-user", { emailVerified: true })).toMatchObject(refusedSignup);
    expect(await call("someone@allowed-domain.test", "create-user", { emailVerified: true, provider: "github" })).toBeUndefined();
    expect(await call("someone@allowed-domain.test", "create-user", { emailVerified: true, provider: "magic-link" })).toBeUndefined();
    // Anyone can put a listed address on their provider profile: it has to be verified.
    expect(await call("someone@allowed-domain.test", "create-user", { provider: "github" })).toMatchObject(refusedSignup);
    expect(await call("someone@allowed-domain.test", "create-user")).toMatchObject(refusedSignup);
    expect(await call("someone@elsewhere.test", "sign-in")).toBeUndefined();
    // Email is optional for Batele ID: the placeholder address may always sign up, through Batele ID only.
    expect(await call("01abc@users.batele-id.invalid", "create-user")).toBeUndefined();
    expect(await call("01abc@users.batele-id.invalid", "create-user", { provider: "github" })).toMatchObject(refusedSignup);
    expect(await call("", "create-user")).toMatchObject(refusedSignup);
  });
});

withDb("invitation codes", () => {
  const stamp = Date.now();
  const ownerEmail = `inv-owner-${stamp}@example.com`;
  const joinerEmail = `inv-joiner-${stamp}@example.com`;
  const slug = `inv-${stamp}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const email of [ownerEmail, joinerEmail]) await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  const send = (credentials: { cookie?: string; token?: string }, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(credentials.cookie ? { Cookie: credentials.cookie } : {}),
        ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("create → preview → accept; revoked, expired, already-member and agent keys are refused", async () => {
    const owner = { cookie: await signIn(ownerEmail) };
    const joiner = { cookie: await signIn(joinerEmail) };
    await send(owner, "POST", "/v1/organizations", { name: "Invite Org", slug });

    const created = await send(owner, "POST", `/v1/orgs/${slug}/invitations`, { role: "guest", expiresInDays: 7 });
    expect(created.status).toBe(201);
    const invitation = (await created.json()) as { id: string; code: string; role: string; status: string };
    expect(invitation).toMatchObject({ role: "guest", status: "active" });

    const preview = await send(joiner, "POST", "/v1/invitations/preview", { code: invitation.code.toLowerCase() });
    expect(await preview.json()).toMatchObject({ organization: { slug }, role: "guest", alreadyMember: false });

    const accepted = await send(joiner, "POST", "/v1/invitations/accept", { code: invitation.code });
    expect(accepted.status).toBe(201);
    const membership = (await accepted.json()) as MembershipDto;
    expect(membership).toMatchObject({ organization: { slug }, actor: { role: "guest", type: "human" } });

    const me = (await (await send(joiner, "GET", "/v1/me")).json()) as MeResponse;
    expect(me.memberships.map((m) => m.organization.slug)).toEqual([slug]);

    const again = await send(joiner, "POST", "/v1/invitations/accept", { code: invitation.code });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { message: string } }).error.message).toBe(
      "You're already a member of Invite Org",
    );

    // Guests can't see or create codes.
    expect((await send(joiner, "GET", `/v1/orgs/${slug}/invitations`)).status).toBe(403);
    expect((await send(joiner, "POST", `/v1/orgs/${slug}/invitations`, {})).status).toBe(403);

    expect((await send(owner, "DELETE", `/v1/orgs/${slug}/invitations/${invitation.id}`)).status).toBe(204);
    const revoked = await send(joiner, "POST", "/v1/invitations/accept", { code: invitation.code });
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { error: { message: string } }).error.message).toBe(
      "Invalid or expired invitation code",
    );

    const expiring = (await (await send(owner, "POST", `/v1/orgs/${slug}/invitations`, {})).json()) as {
      id: string;
      code: string;
    };
    await db
      .update(schema.invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitations.id, expiring.id));
    expect((await send(joiner, "POST", "/v1/invitations/accept", { code: expiring.code })).status).toBe(400);

    const list = (await (await send(owner, "GET", `/v1/orgs/${slug}/invitations`)).json()) as {
      items: { id: string; status: string }[];
    };
    expect(Object.fromEntries(list.items.map((i) => [i.id, i.status]))).toEqual({
      [invitation.id]: "revoked",
      [expiring.id]: "expired",
    });

    // Agent keys can't join organizations.
    const agent = (await (await send(owner, "POST", `/v1/orgs/${slug}/agents`, { name: "Bot" })).json()) as {
      actor: { id: string };
    };
    const { secret } = (await (
      await send(owner, "POST", `/v1/orgs/${slug}/agents/${agent.actor.id}/keys`, { name: "k" })
    ).json()) as { secret: string };
    const fresh = (await (await send(owner, "POST", `/v1/orgs/${slug}/invitations`, {})).json()) as { code: string };
    expect((await send({ token: secret }, "POST", "/v1/invitations/accept", { code: fresh.code })).status).toBe(403);
    expect((await send({ token: secret }, "POST", "/v1/invitations/preview", { code: fresh.code })).status).toBe(403);
  });
});

withDb("members manage their own agents", () => {
  const stamp = Date.now();
  const emails = ["owner", "alice", "bob", "admin", "guest"].map((n) => `agents-${n}-${stamp}@example.com`);
  const slug = `own-agents-${stamp}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const email of emails) await db.delete(schema.user).where(eq(schema.user.email, email));
  });

  const send = (credentials: { cookie?: string; token?: string }, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(credentials.cookie ? { Cookie: credentials.cookie } : {}),
        ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("members create their own agents; only the owner or an admin manages them", async () => {
    const [owner, alice, bob, admin, guest] = await Promise.all(
      emails.map(async (email) => ({ cookie: await signIn(email) })),
    );
    if (!owner || !alice || !bob || !admin || !guest) throw new Error("sign-in failed");
    await send(owner, "POST", "/v1/organizations", { name: "Own Agents", slug });
    for (const [who, role] of [
      [alice, "member"],
      [bob, "member"],
      [admin, "admin"],
      [guest, "guest"],
    ] as const) {
      const { code } = (await (await send(owner, "POST", `/v1/orgs/${slug}/invitations`, { role })).json()) as {
        code: string;
      };
      expect((await send(who, "POST", "/v1/invitations/accept", { code })).status).toBe(201);
    }
    const agents = `/v1/orgs/${slug}/agents`;

    const created = await send(alice, "POST", agents, { name: "Alice Bot" });
    expect(created.status).toBe(201);
    const agent = (await created.json()) as { actor: { id: string }; canManage: boolean };
    expect(agent.canManage).toBe(true);
    expect((await send(guest, "POST", agents, { name: "Guest Bot" })).status).toBe(403);

    const keyRes = await send(alice, "POST", `${agents}/${agent.actor.id}/keys`, { name: "laptop" });
    expect(keyRes.status).toBe(201);
    const { secret, key } = (await keyRes.json()) as { secret: string; key: { id: string } };
    expect((await send({ token: secret }, "POST", agents, { name: "Child Bot" })).status).toBe(403);

    // Bob sees the agent and its owner, but no keys and no actions.
    const bobList = (await (await send(bob, "GET", agents)).json()) as {
      items: { actor: { id: string }; canManage: boolean; keys: unknown[]; owner: { handle: string } }[];
    };
    const seen = bobList.items.find((a) => a.actor.id === agent.actor.id);
    expect(seen).toMatchObject({ canManage: false, keys: [] });
    expect((await send(bob, "PATCH", `${agents}/${agent.actor.id}`, { name: "Mine" })).status).toBe(403);
    expect((await send(bob, "POST", `${agents}/${agent.actor.id}/keys`, { name: "x" })).status).toBe(403);
    expect((await send(bob, "DELETE", `/v1/orgs/${slug}/api-keys/${key.id}`)).status).toBe(403);
    expect((await send(bob, "DELETE", `${agents}/${agent.actor.id}`)).status).toBe(403);

    const renamed = await send(admin, "PATCH", `${agents}/${agent.actor.id}`, { name: "Renamed", handle: "renamed" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ actor: { name: "Renamed", handle: "renamed" }, canManage: true });

    expect((await send({ token: secret }, "GET", "/v1/whoami")).status).toBe(200);
    expect((await send(alice, "DELETE", `${agents}/${agent.actor.id}`)).status).toBe(204);
    expect((await send({ token: secret }, "GET", "/v1/whoami")).status).toBe(401);
    const members = (await (await send(alice, "GET", `/v1/orgs/${slug}/members`)).json()) as { items: { id: string }[] };
    expect(members.items.map((m) => m.id)).not.toContain(agent.actor.id);
    const all = (await (await send(alice, "GET", `/v1/orgs/${slug}/members?all=true`)).json()) as {
      items: { id: string; handle: string; deactivated: boolean }[];
    };
    expect(all.items.find((m) => m.id === agent.actor.id)).toMatchObject({ handle: "renamed", deactivated: true });
    expect(all.items.filter((m) => !m.deactivated)).toHaveLength(members.items.length);
  });
});
