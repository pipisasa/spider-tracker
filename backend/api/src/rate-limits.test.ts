import { afterAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { inArray } from "drizzle-orm";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv, type TrustedProxy } from "./env";
import type { Mailer } from "./mailer";

const databaseUrl = process.env.TEST_DATABASE_URL;

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
};

const sentLinks = new Map<string, string>();
const mailer: Mailer = {
  async sendMagicLink(email, url) {
    sentLinks.set(email, url);
  },
};

const db = createDb(baseEnv.DATABASE_URL);
afterAll(() => db.$client.end());

function makeApp(trustedProxy: TrustedProxy) {
  const env = loadEnv({ ...baseEnv, TRUSTED_PROXY: trustedProxy });
  return {
    env,
    app: createApp({ db, auth: createAuth(db, env, mailer), env }),
  };
}

const post = (
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("client IP", () => {
  test("without a trusted proxy, forged X-Forwarded-For and CF-Connecting-IP don't give fresh buckets", async () => {
    const { app } = makeApp("none");
    for (let i = 0; i < 10; i++) {
      const forged = {
        "X-Forwarded-For": `10.0.0.${i}`,
        "CF-Connecting-IP": `10.1.0.${i}`,
      };
      expect(
        (await post(app, "/v1/agent-invites/accept", { code: "" }, forged))
          .status,
      ).toBe(400);
    }
    const limited = await post(
      app,
      "/v1/agent-invites/accept",
      { code: "" },
      { "X-Forwarded-For": "10.0.0.99" },
    );
    expect(limited.status).toBe(429);
  });

  test("behind Railway, a forged left-most X-Forwarded-For entry doesn't reset the bucket", async () => {
    const { app } = makeApp("railway");
    for (let i = 0; i < 10; i++) {
      const forged = { "X-Forwarded-For": `10.0.0.${i}, 198.51.100.40` };
      expect(
        (await post(app, "/v1/agent-invites/accept", { code: "" }, forged))
          .status,
      ).toBe(400);
    }
    const again = { "X-Forwarded-For": "10.0.0.99, 198.51.100.40" };
    expect(
      (await post(app, "/v1/agent-invites/accept", { code: "" }, again)).status,
    ).toBe(429);
    const other = { "X-Forwarded-For": "10.0.0.99, 198.51.100.41" };
    expect(
      (await post(app, "/v1/agent-invites/accept", { code: "" }, other)).status,
    ).toBe(400);
  });
});

describe("agent invite accepts", () => {
  test("malformed codes don't count toward the global cap", async () => {
    const { app } = makeApp("railway");
    for (let i = 0; i < 150; i++) {
      const from = { "X-Forwarded-For": `198.51.100.${Math.floor(i / 10)}` };
      expect(
        (await post(app, "/v1/agent-invites/accept", { code: "" }, from))
          .status,
      ).toBe(400);
    }
  });

  (databaseUrl ? test : test.skip)(
    "failed accepts of well-formed codes from all clients are capped at 100 an hour",
    async () => {
      const { app } = makeApp("railway");
      for (let i = 0; i < 100; i++) {
        const from = { "X-Forwarded-For": `198.51.100.${Math.floor(i / 10)}` };
        expect(
          (
            await post(
              app,
              "/v1/agent-invites/accept",
              { code: "ZZZZ-ZZZZ" },
              from,
            )
          ).status,
        ).toBe(400);
      }
      const limited = await post(
        app,
        "/v1/agent-invites/accept",
        { code: "ZZZZ-ZZZZ" },
        { "X-Forwarded-For": "203.0.113.200" },
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: { code: "rate_limited" },
      });
    },
  );
});

describe("invitation codes for people", () => {
  test("are rate limited per client IP, preview and accept together", async () => {
    const { app } = makeApp("railway");
    const from = { "X-Forwarded-For": "198.51.100.60" };
    for (let i = 0; i < 10; i++) {
      expect(
        (await post(app, "/v1/invitations/preview", { code: "" }, from)).status,
      ).toBe(401);
      expect(
        (await post(app, "/v1/invitations/accept", { code: "" }, from)).status,
      ).toBe(401);
    }
    const limited = await post(
      app,
      "/v1/invitations/accept",
      { code: "" },
      from,
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(
      (
        await post(
          app,
          "/v1/invitations/preview",
          { code: "" },
          { "X-Forwarded-For": "198.51.100.61" },
        )
      ).status,
    ).toBe(401);
  });

  const withDb = databaseUrl ? describe : describe.skip;

  withDb("signed in", () => {
    const email = `rate-limits-${Date.now()}@example.com`;

    afterAll(async () => {
      await db.delete(schema.user).where(inArray(schema.user.email, [email]));
    });

    test("are rate limited per user, whatever the client IP", async () => {
      const { app, env } = makeApp("railway");
      await post(
        app,
        "/api/auth/sign-in/magic-link",
        { email, callbackURL: `${env.WEB_ORIGIN}/` },
        { Origin: env.WEB_ORIGIN },
      );
      const link = new URL(sentLinks.get(email) ?? "");
      const verify = await app.request(link.pathname + link.search, {
        redirect: "manual",
      });
      const cookie = verify.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      expect(cookie).toContain("session_token");

      const send = (path: string, i: number) =>
        post(
          app,
          path,
          { code: "" },
          { Cookie: cookie, "X-Forwarded-For": `198.51.100.${70 + i}` },
        );
      for (let i = 0; i < 5; i++) {
        expect((await send("/v1/invitations/preview", i)).status).toBe(400);
        expect((await send("/v1/invitations/accept", i)).status).toBe(400);
      }
      const limited = await send("/v1/invitations/preview", 99);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: { code: "rate_limited" },
      });
    });
  });
});
