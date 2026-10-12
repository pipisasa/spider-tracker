import { afterAll, describe, expect, test } from "bun:test";
import { createDb } from "@repo/db";
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

const requestCode = (ip: string) =>
  app.request("/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ client_name: "Rate Limit Test" }),
  });

const withDb = databaseUrl ? describe : describe.skip;

withDb("device login", () => {
  test("requesting device codes is rate limited per client IP", async () => {
    const ip = "198.51.100.20";
    for (let i = 0; i < 10; i++) expect((await requestCode(ip)).status).toBe(200);
    const limited = await requestCode(ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "rate_limited" },
    });
    expect((await requestCode("198.51.100.21")).status).toBe(200);
  });
});
