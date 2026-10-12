import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq } from "drizzle-orm";
import { orgIdOf, type Viewer } from "./access";
import type { ActivityDto } from "./contracts";
import { findTask } from "./tasks";

const { activity } = schema;

/** A task's history, oldest first (task and comment events). */
export async function listTaskActivity(db: Db, viewer: Viewer, taskKey: string): Promise<ActivityDto[]> {
  const { task } = await findTask(db, viewer, taskKey);
  const rows = await db
    .select()
    .from(activity)
    .where(and(eq(activity.orgId, orgIdOf(viewer)), eq(activity.entityType, "task"), eq(activity.entityId, task.id)))
    .orderBy(asc(activity.id));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    changes: r.changes ?? null,
    source: r.source,
    actorId: r.actorId,
    createdAt: r.createdAt.toISOString(),
  }));
}
