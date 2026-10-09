import type { Db, Tx } from "@repo/db";
import { sql } from "drizzle-orm";

// Change events for realtime (ST-13). Writes publish them with pg_notify inside their
// transaction, so listeners only hear about committed changes. Payloads stay small
// (Postgres caps them at 8 kB): clients refetch what they need.

export const EVENTS_CHANNEL = "spider_events";

export type OrgEvent =
  | { type: "task.changed" | "task.deleted"; orgId: string; projectKey: string; taskKey: string }
  | { type: "comment.created"; orgId: string; taskKey: string }
  | { type: "inbox.created"; orgId: string; recipientIds: string[] }
  | { type: "project.changed"; orgId: string; projectKey: string };

export async function publish(tx: Db | Tx, event: OrgEvent) {
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`);
}
