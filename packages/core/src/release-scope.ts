import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { inScope, type ProjectScope } from "./access";
import { DomainError } from "./errors";

// A release can include tasks from any project, while a project-scoped agent sees only its own
// (ST-93). Changes that write to every included task (releasing, unreleasing, canceling, deleting)
// and the changelog written into the description (ST-95) need the whole release, so a scoped
// actor who can't see all of it is refused, without naming what it can't see.

const { projects, statuses, tasks } = schema;

/** The release's live tasks, whatever the viewer can see, by project key then number. */
export const allReleaseTasks = (db: Db | Tx, releaseId: string) =>
  db
    .select({
      id: tasks.id,
      number: tasks.number,
      projectId: tasks.projectId,
      projectKey: projects.key,
      category: statuses.category,
      shippedAt: tasks.shippedAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(eq(tasks.releaseId, releaseId), isNull(tasks.deletedAt)))
    .orderBy(asc(projects.key), asc(tasks.number));

/**
 * Refuses (forbidden) when any of the release's tasks is in a project outside `scope`; the message
 * never names them. `action` ends it: "ask a member to release it".
 */
export function assertSeesWholeRelease(scope: ProjectScope, releaseKey: string, included: { projectId: string }[], action: string) {
  if (included.every((t) => inScope(scope, t.projectId))) return;
  throw new DomainError("forbidden", `Release ${releaseKey} includes tasks in projects you can't see; ask a member to ${action}`);
}
