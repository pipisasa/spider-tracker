import { describe, expect, test } from "bun:test";
import { clientIp, createRateLimiter } from "./rate-limit";
import { loadEnv } from "./env";

const request = (headers: Record<string, string>) => new Request("http://localhost/x", { headers });
const server = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1234 }) });

describe("clientIp", () => {
  const spoofed = { "CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "2.2.2.2, 3.3.3.3" };

  test("none: ignores proxy headers and uses the socket address", () => {
    expect(clientIp(request(spoofed), "none", server("192.0.2.10"))).toBe("192.0.2.10");
  });

  test("none: one shared bucket when the socket address is unknown", () => {
    expect(clientIp(request(spoofed), "none")).toBe("unknown");
    expect(clientIp(request(spoofed), "none", {})).toBe("unknown");
  });

  test("cloudflare: CF-Connecting-IP, never X-Forwarded-For", () => {
    expect(clientIp(request(spoofed), "cloudflare", server("192.0.2.10"))).toBe("1.1.1.1");
    expect(clientIp(request({ "X-Forwarded-For": "2.2.2.2" }), "cloudflare", server("192.0.2.10"))).toBe(
      "192.0.2.10",
    );
  });

  test("railway: the right-most X-Forwarded-For entry; CF-Connecting-IP is ignored", () => {
    expect(clientIp(request(spoofed), "railway")).toBe("3.3.3.3");
    expect(clientIp(request({ "X-Forwarded-For": " 203.0.113.5 , " }), "railway")).toBe("203.0.113.5");
    expect(clientIp(request({ "CF-Connecting-IP": "1.1.1.1" }), "railway", server("192.0.2.10"))).toBe("192.0.2.10");
  });

  test("spoofed headers don't reset a client's bucket", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const from = (forged: string) =>
      limiter.attempt(
        clientIp(
          request({ "CF-Connecting-IP": forged, "X-Forwarded-For": `${forged}, 198.51.100.1` }),
          "railway",
        ),
        0,
      );
    expect(from("10.0.0.1")).toBe(true);
    expect(from("10.0.0.2")).toBe(true);
    expect(from("10.0.0.3")).toBe(false);
  });
});

describe("createRateLimiter", () => {
  test("exhausted reports a used-up key without counting", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.exhausted("k", 0)).toBe(false);
    limiter.attempt("k", 0);
    expect(limiter.exhausted("k", 0)).toBe(false);
    limiter.attempt("k", 0);
    expect(limiter.exhausted("k", 0)).toBe(true);
    expect(limiter.exhausted("k", 1000)).toBe(false);
  });
});

describe("TRUSTED_PROXY in production", () => {
  const base = {
    DATABASE_URL: "postgres://localhost:5432/unused",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  };
  test("is required, so a forgotten deploy step fails at startup", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production" })).toThrow("TRUSTED_PROXY");
    expect(loadEnv({ ...base, NODE_ENV: "production", TRUSTED_PROXY: "railway" }).TRUSTED_PROXY).toBe("railway");
    expect(loadEnv({ ...base, NODE_ENV: "development" }).TRUSTED_PROXY).toBe("none");
  });
});
