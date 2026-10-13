// Applies pending migrations without drizzle-kit (used at deploy time).
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = postgres(url, { max: 1, onnotice: () => {} });
await migrate(drizzle({ client }), {
  migrationsFolder: new URL("../migrations", import.meta.url).pathname,
});
await client.end();
console.info("migrations applied");
