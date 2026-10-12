import { afterAll, describe, expect, test } from "bun:test";
import { createDb } from "@repo/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv, type TrustedProxy } from "./env";

const databaseUrl = process.env.TEST_DATABASE_URL;

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
};

const db = createDb(baseEnv.DATABASE_URL);
afterAll(() => db.$client.end());

function makeApp(trustedProxy: TrustedProxy) {
  const env = loadEnv({ ...baseEnv, TRUSTED_PROXY: trustedProxy });
  const auth = createAuth(db, env, { async sendMagicLink() {} }, { rateLimit: true });
  return createApp({ db, auth, env });
}

// Better Auth allows 5 magic-link requests per minute per client IP.
const LIMIT = 5;

const requestLink = (app: ReturnType<typeof makeApp>, headers: Record<string, string>) =>
  app.request("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseEnv.WEB_ORIGIN, ...headers },
    body: JSON.stringify({ email: "auth-ip@example.com" }),
  });

describe.skipIf(!databaseUrl)("Better Auth client IP", () => {
  test("behind Railway, forged CF-Connecting-IP and left-most X-Forwarded-For don't give fresh buckets", async () => {
    const app = makeApp("railway");
    for (let i = 0; i < LIMIT; i++) {
      const forged = {
        "X-Forwarded-For": `10.0.0.${i}, 198.51.100.60`,
        "CF-Connecting-IP": `10.1.0.${i}`,
        "X-Spider-Client-IP": `10.2.0.${i}`,
      };
      expect((await requestLink(app, forged)).status).toBe(200);
    }
    const again = { "X-Forwarded-For": "10.0.0.99, 198.51.100.60", "CF-Connecting-IP": "10.1.0.99" };
    expect((await requestLink(app, again)).status).toBe(429);
    expect((await requestLink(app, { "X-Forwarded-For": "10.0.0.99, 198.51.100.61" })).status).toBe(200);
  });

  test("behind Cloudflare, a forged X-Forwarded-For doesn't give a fresh bucket", async () => {
    const app = makeApp("cloudflare");
    for (let i = 0; i < LIMIT; i++) {
      const forged = { "CF-Connecting-IP": "198.51.100.70", "X-Forwarded-For": `10.0.0.${i}` };
      expect((await requestLink(app, forged)).status).toBe(200);
    }
    expect((await requestLink(app, { "CF-Connecting-IP": "198.51.100.70", "X-Forwarded-For": "10.0.0.99" })).status).toBe(429);
  });

  test("without a trusted proxy, forged headers are all ignored", async () => {
    const app = makeApp("none");
    for (let i = 0; i < LIMIT; i++) {
      const forged = { "X-Forwarded-For": `10.0.0.${i}`, "CF-Connecting-IP": `10.1.0.${i}`, "X-Spider-Client-IP": `10.2.0.${i}` };
      expect((await requestLink(app, forged)).status).toBe(200);
    }
    expect((await requestLink(app, { "X-Forwarded-For": "10.0.0.99", "CF-Connecting-IP": "10.1.0.99" })).status).toBe(429);
  });
});
