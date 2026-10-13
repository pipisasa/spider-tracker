import type { AuthProvider } from "@repo/core";
import {
  isSignupAllowed,
  mayReceiveMagicLink,
  parseAllowlist,
} from "@repo/core";
import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";
import { BATELE_PLACEHOLDER_DOMAIN, bateleIdProvider } from "./batele-id";
import type { Env } from "./env";
import type { Mailer } from "./mailer";

/** Sign-in methods available with the current configuration, shown on the login page. */
export function enabledAuthProviders(env: Env): AuthProvider[] {
  const providers: AuthProvider[] = ["magic-link"];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
    providers.push("github");
  if (env.BATELE_ID_CLIENT_ID) providers.push("batele-id");
  return providers;
}

/**
 * The header carrying the client IP Better Auth sees. app.ts sets it from `clientIp` (governed by
 * `TRUSTED_PROXY`) and drops any client-sent copy, so Better Auth never reads a forgeable header.
 */
export const CLIENT_IP_HEADER = "x-spider-client-ip";

/** Sends magic-link email after the response: logs failures, never the link or the key. */
export function sendInBackground(task: Promise<void>): void {
  task.catch((err: unknown) =>
    console.error("[mail] sending a magic link failed:", err),
  );
}

export function createAuth(
  db: Db,
  env: Env,
  mailer: Mailer,
  {
    rateLimit = env.NODE_ENV === "production",
    background = sendInBackground,
  }: {
    /** Better Auth's own rate limits; on in production by default. */
    rateLimit?: boolean;
    /** Runs the email send without holding the response open; tests may replace it. */
    background?: (task: Promise<void>) => void;
  } = {},
) {
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : undefined;
  const allowlist = parseAllowlist(env.SIGNUP_ALLOWLIST);
  const bateleId = env.BATELE_ID_CLIENT_ID
    ? [
        genericOAuth({
          config: [
            bateleIdProvider(env.BATELE_ID_CLIENT_ID, env.BATELE_ID_ISSUER),
          ],
        }),
      ]
    : [];

  return betterAuth({
    appName: "Spider Tracker",
    baseURL: env.API_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    socialProviders: github,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          // Don't send links that could only end in a refused sign-up. Both paths do the same
          // lookup and the email goes out in the background, so neither the response nor its
          // timing reveals who is allowed (ST-56).
          const [existing] = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(eq(schema.user.email, email.toLowerCase()))
            .limit(1);
          if (
            !mayReceiveMagicLink({
              email,
              allowlist,
              userExists: existing !== undefined,
            })
          )
            return;
          background(mailer.sendMagicLink(email, url));
        },
      }),
      ...bateleId,
    ],
    user: {
      // Runs before any user is created, for every sign-in method (magic link, GitHub, Batele ID).
      // The address must be on the list and verified by the method: anyone can put a listed
      // address on their GitHub or Batele ID profile. Magic links verify it by delivery.
      validateUserInfo: ({ user, source }) => {
        if (source.action !== "create-user") return;
        const email = typeof user.email === "string" ? user.email : "";
        // Email is optional for Batele ID: users without one get a placeholder address and may
        // always sign up. Only Batele ID may use it; `.invalid` never receives a magic link.
        if (
          source.oauth?.providerId === "batele-id" &&
          email.endsWith(`@${BATELE_PLACEHOLDER_DOMAIN}`)
        )
          return;
        if (
          email &&
          isSignupAllowed(
            { email, emailVerified: user.emailVerified === true },
            allowlist,
          )
        )
          return;
        return {
          error: "signup_not_allowed",
          errorDescription:
            "This account isn't allowed to sign up. Ask an admin to add you.",
        };
      },
    },
    account: {
      accountLinking: {
        // Never merge accounts automatically at sign-in (Batele ID emails aren't verified);
        // linking happens only through linkSocial() while signed in, with a matching email.
        disableImplicitLinking: true,
        trustedProviders: ["batele-id", "github"],
      },
    },
    // OAuth errors land on the web app's login page (`?error=<code>`), not on the API.
    onAPIError: { errorURL: `${env.WEB_ORIGIN}/login` },
    rateLimit: { enabled: rateLimit },
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
