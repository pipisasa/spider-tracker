import { afterAll, describe, expect, test } from "bun:test";
import type { MeResponse, MembershipDto } from "@repo/core";
import { createDb, schema } from "@repo/db";
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
