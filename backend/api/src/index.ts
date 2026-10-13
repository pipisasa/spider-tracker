import { createDb } from "@repo/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { githubAppConfig, loadEnv } from "./env";
import { createGithubApp } from "./github";
import { createMailer } from "./mailer";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const auth = createAuth(db, env, createMailer(env));
const githubConfig = githubAppConfig(env);
const app = createApp({
  db,
  auth,
  env,
  github: githubConfig ? createGithubApp(githubConfig) : null,
});

console.info(`api listening on ${env.API_ORIGIN}`);

// Long enough for waiting inbox requests (up to 25 s); Bun's default is 10 s.
export default { port: env.PORT, fetch: app.fetch, idleTimeout: 60 };
