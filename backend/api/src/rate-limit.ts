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
  };
}

/** The client IP from the same headers Better Auth trusts (cf-connecting-ip, then x-forwarded-for). */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
