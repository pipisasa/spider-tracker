import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  API_ORIGIN: z.url(),
  WEB_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "Use at least 32 random characters"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  BATELE_ID_CLIENT_ID: z.string().optional(),
  /** Emails and "@domain" entries allowed to create accounts; empty = anyone (ST-17). */
  SIGNUP_ALLOWLIST: z.string().optional(),
  BATELE_ID_ISSUER: z.url().default("https://api-v2.batele.plus/auth"),
  /** Resend API key; without it magic links are printed to the console (ST-18). */
  RESEND_API_KEY: z.string().optional(),
  /** Sender of outgoing email; the domain must be verified in Resend. */
  MAIL_FROM: z.string().default("Spider Tracker <noreply@batele.plus>"),
  /**
   * The proxy in front of the API whose client-IP header rate limits trust (ST-45):
   * "none" (socket address), "cloudflare" (CF-Connecting-IP) or "railway" (right-most X-Forwarded-For).
   */
  TRUSTED_PROXY: z.enum(["none", "cloudflare", "railway"]).default("none"),
});

export type TrustedProxy = z.infer<typeof envSchema>["TRUSTED_PROXY"];

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  // Behind a proxy the socket address is the proxy's, so "none" would put every client in one bucket.
  if (parsed.data.NODE_ENV === "production" && !source.TRUSTED_PROXY) {
    throw new Error("Invalid environment:\n  TRUSTED_PROXY: Required in production (none, cloudflare or railway)");
  }
  return parsed.data;
}
