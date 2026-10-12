import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { inArray, sql } from "drizzle-orm";
import { projectScope, type Viewer } from "./access";

// Change events for realtime (ST-13). Writes publish them with pg_notify inside their
// transaction, so listeners only hear about committed changes. Payloads stay small
// (Postgres caps them at 8 kB): clients refetch what they need.

export const EVENTS_CHANNEL = "spider_events";

export type OrgEvent =
  | { type: "task.changed" | "task.deleted"; orgId: string; projectKey: string; taskKey: string }
  | { type: "comment.created"; orgId: string; taskKey: string }
  | { type: "presence"; orgId: string; taskKey: string }
  | { type: "inbox.created"; orgId: string; recipientIds: string[] }
  | { type: "project.changed"; orgId: string; projectKey: string }
  | { type: "tags.changed"; orgId: string }
  | { type: "repos.changed"; orgId: string }
  | {
      /** `document.commented`: a comment on the document was added, resolved or reopened (ST-118). */
      type: "document.changed" | "document.deleted" | "document.commented";
      orgId: string;
      documentId: string;
      projectKey: string | null;
      taskKey: string | null;
    };

export async function publish(tx: Db | Tx, event: OrgEvent) {
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(event)})`);
}

/** Keys of the projects in a viewer's scope, or null when it sees every project (for filtering events). */
export async function scopedProjectKeys(db: Db, viewer: Viewer): Promise<Set<string> | null> {
  const scope = await projectScope(db, viewer);
  if (!scope) return null;
  if (scope.size === 0) return new Set();
  const rows = await db
    .select({ key: schema.projects.key })
    .from(schema.projects)
    .where(inArray(schema.projects.id, [...scope]));
  return new Set(rows.map((r) => r.key));
}

/** Whether an event concerns only projects inside `keys` (null: everything is visible). */
export function eventInScope(event: OrgEvent, keys: Set<string> | null): boolean {
  if (!keys) return true;
  switch (event.type) {
    case "task.changed":
    case "task.deleted":
    case "project.changed":
      return keys.has(event.projectKey);
    case "comment.created":
    case "presence":
      return keys.has(event.taskKey.split("-")[0] ?? "");
    case "document.changed":
    case "document.deleted":
    case "document.commented":
      return event.projectKey === null || keys.has(event.projectKey);
    default:
      return true;
  }
}
