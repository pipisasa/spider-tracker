import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import type { Env } from "./env";
import type { Mailer } from "./mailer";

export function createAuth(db: Db, env: Env, mailer: Mailer) {
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : undefined;

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
        sendMagicLink: ({ email, url }) => mailer.sendMagicLink(email, url),
      }),
    ],
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
