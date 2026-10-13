import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { ActorContext, ProjectScope } from "./access";
import { recordActivity } from "./activity";
import { systemContext } from "./bots";
import type {
  MilestoneProgressDto,
  StatusCategory,
  TaskKind,
} from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";

// Milestone membership (ST-96). A task joins a milestone through its own `milestone_id`; a
// sub-task without one belongs to its nearest ancestor's milestone. That inheritance is computed
// on read (recursive queries below), never stored, so re-parenting a task or changing a parent's
// milestone moves its whole subtree with no copies to keep in step. Only tasks of kind "task" are
// members, and the walk only passes through such tasks of the same project: a sub-task whose parent
// is in another project never inherits that parent's milestone, so a milestone never reaches
// outside its own project (and a scoped actor can't settle a milestone it can't see).

const { projects, statuses, tasks } = schema;

/** As deep as sub-tasks may nest (tasks.ts). */
const MAX_DEPTH = 20;

const uuidList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export interface Membership {
  milestoneId: string;
  /** Through an ancestor, not the task's own `milestone_id`. */
  inherited: boolean;
}

/** The milestone each task belongs to (its own, else the nearest ancestor's); tasks in none are left out. */
export async function effectiveMilestones(
  db: Db | Tx,
  taskIds: string[],
): Promise<Map<string, Membership>> {
  const map = new Map<string, Membership>();
  if (taskIds.length === 0) return map;
  const rows = await db.execute<{
    origin: string;
    milestone_id: string;
    depth: number;
  }>(sql`
    with recursive up(origin, project_id, parent_id, milestone_id, depth) as (
      select t.id, t.project_id, t.parent_id, t.milestone_id, 0 from tasks t
      where t.id in (${uuidList(taskIds)}) and t.kind = 'task'
      union all
      select up.origin, up.project_id, p.parent_id, p.milestone_id, up.depth + 1 from up
      join tasks p on p.id = up.parent_id and p.deleted_at is null and p.kind = 'task' and p.project_id = up.project_id
      where up.milestone_id is null and up.depth < ${MAX_DEPTH}
    )
    select origin, milestone_id, depth from up where milestone_id is not null
  `);
  for (const row of rows)
    map.set(row.origin, {
      milestoneId: row.milestone_id,
      inherited: Number(row.depth) > 0,
    });
  return map;
}

export interface MemberRow {
  milestoneId: string;
  inherited: boolean;
  task: typeof tasks.$inferSelect;
  projectKey: string;
  status: { id: string; name: string; category: StatusCategory };
}

/** The live tasks of each milestone (inside `scope`), by project key and number. */
export async function milestoneMembers(
  db: Db | Tx,
  scope: ProjectScope,
  milestoneIds: string[],
): Promise<MemberRow[]> {
  if (milestoneIds.length === 0) return [];
  const members = await db.execute<{
    id: string;
    milestone_id: string;
    depth: number;
  }>(sql`
    with recursive member(id, project_id, milestone_id, depth) as (
      select t.id, t.project_id, t.milestone_id, 0 from tasks t
      where t.milestone_id in (${uuidList(milestoneIds)}) and t.deleted_at is null and t.kind = 'task'
      union all
      select c.id, c.project_id, m.milestone_id, m.depth + 1 from tasks c
      join member m on c.parent_id = m.id
      where c.milestone_id is null and c.deleted_at is null and c.kind = 'task' and c.project_id = m.project_id
        and m.depth < ${MAX_DEPTH}
    )
    select id, milestone_id, depth from member
  `);
  if (members.length === 0) return [];
  const byTask = new Map(
    members.map((m) => [
      m.id,
      { milestoneId: m.milestone_id, inherited: Number(m.depth) > 0 },
    ]),
  );
  const rows = await db
    .select({
      task: tasks,
      projectKey: projects.key,
      status: {
        id: statuses.id,
        name: statuses.name,
        category: statuses.category,
      },
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(
      and(
        inArray(tasks.id, [...byTask.keys()]),
        scope ? inArray(tasks.projectId, [...scope]) : undefined,
      ),
    )
    .orderBy(asc(projects.key), asc(tasks.number));
  return rows.flatMap((row) => {
    const membership = byTask.get(row.task.id);
    return membership ? [{ ...membership, ...row }] : [];
  });
}

/** Progress over a milestone's tasks: canceled ones don't count; Done ones with code count as shipped once released. */
export function progressOf(
  members: Pick<MemberRow, "task" | "status">[],
): MilestoneProgressDto {
  const live = members.filter((m) => m.status.category !== "canceled");
  const done = live.filter((m) => m.status.category === "done");
  const withCode = done.filter((m) => !m.task.noCode);
  const shipped = withCode.filter((m) => m.task.shippedAt !== null);
  return {
    total: live.length,
    done: done.length,
    canceled: members.length - live.length,
    withCode: withCode.length,
    shipped: shipped.length,
    complete:
      live.length > 0 &&
      done.length === live.length &&
      shipped.length === withCode.length,
  };
}

/**
 * A task may join a milestone: it is an ordinary task, and the milestone is a live milestone of
 * the same project.
 */
export async function assertMilestoneFor(
  tx: Tx,
  task: { kind: TaskKind; projectId: string; label: string },
  milestoneId: string,
) {
  if (task.kind !== "task")
    throw new DomainError(
      "validation",
      `Only tasks go into a milestone; ${task.label} is a ${task.kind}`,
    );
  const [milestone] = await tx
    .select({
      kind: tasks.kind,
      number: tasks.number,
      projectId: tasks.projectId,
      projectKey: projects.key,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, milestoneId), isNull(tasks.deletedAt)))
    .limit(1);
  if (!milestone || milestone.projectId !== task.projectId) {
    throw new DomainError(
      "validation",
      `Milestone not found in ${task.label}'s project; a task joins a milestone of its own project`,
    );
  }
  if (milestone.kind !== "milestone") {
    throw new DomainError(
      "validation",
      `${milestone.projectKey}-${milestone.number} is a ${milestone.kind}, not a milestone`,
    );
  }
}

/** Categories a milestone moves on from by itself: not yet Ready to close, Done or canceled. */
const OPEN: StatusCategory[] = ["backlog", "todo", "in_progress"];

/**
 * Moves each of these milestones that is complete (every task Done, all their code shipped) and
 * still open (Planned, Active) to the first status of category `in_review` of its workflow ("Ready
 * to close"), as the Spider Tracker bot (source "system"). Never backwards: a person closes it, or
 * reopens it. Runs inside the transaction of the change that may have completed it; the milestone
 * rows are locked first, so two tasks finishing at once can't both miss the other's change.
 */
export async function settleMilestones(
  tx: Tx,
  orgId: string,
  milestoneIds: (string | null | undefined)[],
): Promise<void> {
  const ids = [
    ...new Set(
      milestoneIds.filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  if (ids.length === 0) return;
  const rows = await tx
    .select({
      task: tasks,
      projectKey: projects.key,
      category: statuses.category,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(
      and(
        inArray(tasks.id, ids),
        eq(tasks.orgId, orgId),
        eq(tasks.kind, "milestone"),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(asc(tasks.id))
    .for("update", { of: tasks });
  const open = rows.filter((r) => OPEN.includes(r.category));
  if (open.length === 0) return;
  const members = await milestoneMembers(
    tx,
    null,
    open.map((r) => r.task.id),
  );
  for (const { task, projectKey } of open) {
    if (!progressOf(members.filter((m) => m.milestoneId === task.id)).complete)
      continue;
    const [target] = await tx
      .select({ id: statuses.id })
      .from(statuses)
      .where(
        and(
          eq(statuses.projectId, task.projectId),
          eq(statuses.kind, "milestone"),
          eq(statuses.category, "in_review"),
        ),
      )
      .orderBy(asc(statuses.position))
      .limit(1);
    // A workflow edited to have no such status leaves the milestone where it is.
    if (!target) continue;
    const [last] = await tx
      .select({ sortKey: tasks.sortKey })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, task.projectId),
          eq(tasks.statusId, target.id),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(desc(tasks.sortKey))
      .limit(1);
    await tx
      .update(tasks)
      .set({
        statusId: target.id,
        sortKey: generateKeyBetween(last?.sortKey ?? null, null),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    const ctx = await systemContext(tx, orgId);
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.updated",
      changes: { statusId: [task.statusId, target.id] },
    });
    await publish(tx, {
      type: "task.changed",
      orgId,
      projectKey,
      taskKey: `${projectKey}-${task.number}`,
    });
  }
}

/** A deleted milestone lets go of its tasks (their `milestone_id`); their sub-tasks follow. */
export async function milestoneTasksOnDelete(
  tx: Tx,
  ctx: ActorContext,
  milestoneId: string,
) {
  const now = new Date();
  const freed = await tx
    .update(tasks)
    .set({ milestoneId: null, updatedAt: now })
    .where(eq(tasks.milestoneId, milestoneId))
    .returning({
      id: tasks.id,
      number: tasks.number,
      projectId: tasks.projectId,
      deletedAt: tasks.deletedAt,
    });
  const live = freed.filter((t) => !t.deletedAt);
  if (live.length === 0) return;
  const keys = await tx
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(inArray(projects.id, [...new Set(live.map((t) => t.projectId))]));
  for (const task of live) {
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.updated",
      changes: { milestoneId: [milestoneId, null] },
    });
    const projectKey = keys.find((p) => p.id === task.projectId)?.key;
    if (projectKey)
      await publish(tx, {
        type: "task.changed",
        orgId: ctx.orgId,
        projectKey,
        taskKey: `${projectKey}-${task.number}`,
      });
  }
}
