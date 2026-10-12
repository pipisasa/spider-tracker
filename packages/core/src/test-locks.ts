import type { Db } from "@repo/db";
import { sql, type SQL } from "drizzle-orm";

// Test helper: forces two requests to interleave. `holdLock` runs `lock` (e.g. a SELECT … FOR
// UPDATE) in a transaction kept open until `release`; `waitForLockWaiters` resolves once that
// many sessions wait on a lock in statements mentioning `table`.

export async function holdLock(db: Db, lock: SQL) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = db.transaction(async (tx) => {
    await tx.execute(lock);
    locked();
    await gate;
  });
  await isLocked;
  return async () => {
    release();
    await done;
  };
}

export async function waitForLockWaiters(db: Db, table: string, count: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike ${`%"${table}"%`}`,
    );
    if ((row?.n ?? 0) >= count) return;
    await Bun.sleep(10);
  }
  throw new Error(`Expected ${count} sessions waiting on a lock`);
}

/** Settles a promise into its error (or null), so a rejection isn't unhandled while we wait. */
export const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) => err,
  );
