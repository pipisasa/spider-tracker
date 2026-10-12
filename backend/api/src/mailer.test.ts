import { describe, expect, test } from "bun:test";
import { loadEnv } from "./env";
import { consoleMailer, createMailer, createResendMailer, magicLinkEmail } from "./mailer";

const baseEnv = {
  DATABASE_URL: "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
};

describe("mailer", () => {
  test("Resend mailer posts the magic link from MAIL_FROM", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = createResendMailer({
      apiKey: "re_test",
      from: "Spider Tracker <noreply@batele.plus>",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ id: "email-1" });
      },
    });
    await mailer.sendMagicLink("ada@example.com", "https://tracker-api.batele.plus/api/auth/magic-link/verify?token=abc&callbackURL=%2F");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("Authorization")).toBe("Bearer re_test");
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ from: "Spider Tracker <noreply@batele.plus>", to: ["ada@example.com"], subject: "Sign in to Spider Tracker" });
    expect(body.text).toContain("token=abc&callbackURL=%2F");
    expect(body.html).toContain('href="https://tracker-api.batele.plus/api/auth/magic-link/verify?token=abc&amp;callbackURL=%2F"');
  });

  test("a refused email throws without leaking the key", async () => {
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "noreply@batele.plus",
      fetch: async () => Response.json({ statusCode: 403, name: "validation_error", message: "Domain not verified" }, { status: 403 }),
    });
    const error = await mailer.sendMagicLink("ada@example.com", "https://x.test/verify").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("403");
    expect(String(error)).toContain("Domain not verified");
    expect(String(error)).not.toContain("re_secret");
  });

  test("the HTML email escapes the link", () => {
    expect(magicLinkEmail('https://x.test/?a="<b>"').html).toContain("https://x.test/?a=&quot;&lt;b&gt;&quot;");
  });

  test("createMailer uses Resend only when RESEND_API_KEY is set", () => {
    expect(createMailer(loadEnv({ ...baseEnv, NODE_ENV: "test" }))).toBe(consoleMailer);
    const env = loadEnv({ ...baseEnv, NODE_ENV: "test", RESEND_API_KEY: "re_test" });
    expect(env.MAIL_FROM).toBe("Spider Tracker <noreply@batele.plus>");
    expect(createMailer(env)).not.toBe(consoleMailer);
  });
});
