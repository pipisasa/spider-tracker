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

export default { port: env.PORT, fetch: app.fetch };
