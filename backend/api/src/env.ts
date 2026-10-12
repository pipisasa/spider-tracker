import { z } from "zod";

/** Unset when missing or empty (`.env.example` leaves them empty). */
const optional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

/** The GitHub App (ST-82): all or none. Separate from GITHUB_CLIENT_ID/SECRET, which are for sign-in. */
const GITHUB_APP_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;

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
  GITHUB_APP_ID: optional,
  GITHUB_APP_SLUG: optional,
  /** The App's private key: the PEM, or the PEM base64-encoded (one line, easier to store). */
  GITHUB_APP_PRIVATE_KEY: optional,
  GITHUB_APP_WEBHOOK_SECRET: optional,
  GITHUB_APP_CLIENT_ID: optional,
  GITHUB_APP_CLIENT_SECRET: optional,
});

export type TrustedProxy = z.infer<typeof envSchema>["TRUSTED_PROXY"];

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const githubSet = GITHUB_APP_VARS.filter((name) => parsed.data[name] !== undefined);
  if (githubSet.length > 0 && githubSet.length < GITHUB_APP_VARS.length) {
    const missing = GITHUB_APP_VARS.filter((name) => !githubSet.includes(name));
    throw new Error(`Invalid environment:\n  ${missing.join(", ")}: Required with the other GITHUB_APP_* variables (set all or none)`);
  }
  if (parsed.data.GITHUB_APP_ID !== undefined && !/^\d+$/.test(parsed.data.GITHUB_APP_ID)) {
    throw new Error("Invalid environment:\n  GITHUB_APP_ID: The App ID is a number");
  }
  if (parsed.data.GITHUB_APP_PRIVATE_KEY !== undefined && !decodePrivateKey(parsed.data.GITHUB_APP_PRIVATE_KEY)) {
    throw new Error("Invalid environment:\n  GITHUB_APP_PRIVATE_KEY: Expected a PEM private key or its base64 encoding");
  }
  // Behind a proxy the socket address is the proxy's, so "none" would put every client in one bucket.
  if (parsed.data.NODE_ENV === "production" && !source.TRUSTED_PROXY) {
    throw new Error("Invalid environment:\n  TRUSTED_PROXY: Required in production (none, cloudflare or railway)");
  }
  return parsed.data;
}

/** A PEM key as given, or decoded from base64; null when it is neither. */
function decodePrivateKey(value: string): string | null {
  const pem = value.includes("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
  // Railway and shells may turn newlines into "\n".
  const normalized = pem.replace(/\\n/g, "\n").trim();
  return /^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(normalized) ? `${normalized}\n` : null;
}

export interface GithubAppConfig {
  appId: string;
  slug: string;
  /** PEM. */
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

/** The GitHub App's settings, or null when the GITHUB_APP_* variables aren't set (the feature is off). */
export function githubAppConfig(env: Env): GithubAppConfig | null {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET } =
    env;
  if (
    !GITHUB_APP_ID ||
    !GITHUB_APP_SLUG ||
    !GITHUB_APP_PRIVATE_KEY ||
    !GITHUB_APP_WEBHOOK_SECRET ||
    !GITHUB_APP_CLIENT_ID ||
    !GITHUB_APP_CLIENT_SECRET
  ) {
    return null;
  }
  const privateKey = decodePrivateKey(GITHUB_APP_PRIVATE_KEY);
  if (!privateKey) return null;
  return {
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    privateKey,
    webhookSecret: GITHUB_APP_WEBHOOK_SECRET,
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
  };
}
