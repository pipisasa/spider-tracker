import { createDb } from "@repo/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { consoleMailer } from "./mailer";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const auth = createAuth(db, env, consoleMailer);
const app = createApp({ db, auth, env });

console.info(`api listening on ${env.API_ORIGIN}`);

// Long enough for waiting inbox requests (up to 25 s); Bun's default is 10 s.
export default { port: env.PORT, fetch: app.fetch, idleTimeout: 60 };
