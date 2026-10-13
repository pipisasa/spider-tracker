import type { TrustedProxy } from "./env";

/**
 * Fixed-window, in-memory rate limit per key (e.g. client IP). Best-effort: each API instance
 * counts on its own and counts reset on restart.
 */
export function createRateLimiter({
  limit,
  windowMs,
}: {
  limit: number;
  windowMs: number;
}) {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    /** Counts an attempt; false when the key has used up its attempts in the current window. */
    attempt(key: string, now = Date.now()): boolean {
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      }
      const current = windows.get(key);
      if (!current || current.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
    /** True when the key has used up its attempts in the current window; counts nothing. */
    exhausted(key: string, now = Date.now()): boolean {
      const current = windows.get(key);
      return !!current && current.resetAt > now && current.count >= limit;
    },
  };
}

/** The TCP peer address from Bun's server (the 2nd `fetch` argument, Hono's `c.env`), if any. */
function socketIp(server: unknown, request: Request): string | undefined {
  if (typeof server !== "object" || server === null) return undefined;
  if (!("requestIP" in server) || typeof server.requestIP !== "function")
    return undefined;
  const info: unknown = server.requestIP(request);
  if (typeof info !== "object" || info === null || !("address" in info))
    return undefined;
  return typeof info.address === "string" && info.address
    ? info.address
    : undefined;
}

/**
 * The client IP for rate limits. Only headers set by the proxy named in `TRUSTED_PROXY` count;
 * anything else a client sends is ignored, so it can't pick a fresh bucket per request:
 * - `none`: the socket address (all requests share the "unknown" bucket when there is none).
 * - `cloudflare`: `CF-Connecting-IP` (only safe when the API is reachable through Cloudflare alone).
 * - `railway`: the right-most `X-Forwarded-For` entry, the one Railway's edge appended.
 */
export function clientIp(
  request: Request,
  trustedProxy: TrustedProxy,
  server?: unknown,
): string {
  const headers = request.headers;
  if (trustedProxy === "cloudflare") {
    const cf = headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
  } else if (trustedProxy === "railway") {
    const hops = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const last = hops.at(-1);
    if (last) return last;
  }
  return socketIp(server, request) ?? "unknown";
}
