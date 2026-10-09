import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { assertCanWrite, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import { notify } from "./inbox";
import type { Priority, TaskDto } from "./contracts";
import { DomainError } from "./errors";
import { createTaskInput, parseTaskKey, updateTaskInput, type UpdateTaskInput } from "./schemas";
import { parseInput } from "./validate";

const { actors, projects, statuses, taskAssignees, tasks } = schema;

type TaskRow = typeof tasks.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

const CLOSED: StatusRow["category"][] = ["done", "canceled"];

function toTaskDto(row: TaskRow, projectKey: string, assigneeIds: string[]): TaskDto {
  return {
    id: row.id,
    key: `${projectKey}-${row.number}`,
    number: row.number,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    statusId: row.statusId,
    priority: row.priority as Priority,
    parentId: row.parentId,
    sortKey: row.sortKey,
    assigneeIds,
    creatorId: row.creatorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function assigneesByTask(db: Db | Tx, taskIds: string[]) {
  const map = new Map<string, string[]>();
  if (taskIds.length === 0) return map;
  const rows = await db
    .select({ taskId: taskAssignees.taskId, actorId: taskAssignees.actorId })
    .from(taskAssignees)
    .where(inArray(taskAssignees.taskId, taskIds))
    .orderBy(asc(taskAssignees.assignedAt));
  for (const row of rows) map.set(row.taskId, [...(map.get(row.taskId) ?? []), row.actorId]);
  return map;
}

async function findStatus(tx: Tx, projectId: string, statusId: string) {
  const [status] = await tx
    .select()
    .from(statuses)
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, projectId)))
    .limit(1);
  if (!status) throw new DomainError("validation", "Status doesn't belong to this project");
  return status;
}

async function assertActorsInOrg(tx: Tx, orgId: string, actorIds: string[]) {
  if (actorIds.length === 0) return;
  const unique = [...new Set(actorIds)];
  const rows = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.orgId, orgId), inArray(actors.id, unique), isNull(actors.deactivatedAt)));
  if (rows.length !== unique.length) throw new DomainError("validation", "Assignees must be members of this organization");
}

async function assertParent(tx: Tx, orgId: string, parentId: string, selfId?: string) {
  if (parentId === selfId) throw new DomainError("validation", "A task can't be its own parent");
  const [parent] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, parentId), eq(tasks.orgId, orgId), isNull(tasks.deletedAt)))
    .limit(1);
  if (!parent) throw new DomainError("validation", "Parent task not found");
}

/** Sort key placing a task after `afterId` and before `beforeId` in a status column (end if neither). */
async function sortKeyFor(
  tx: Tx,
  projectId: string,
  statusId: string,
  position: { afterId?: string | null; beforeId?: string | null } = {},
) {
  const neighbour = async (id: string) => {
    const [row] = await tx
      .select({ sortKey: tasks.sortKey })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId), eq(tasks.statusId, statusId), isNull(tasks.deletedAt)))
      .limit(1);
    if (!row) throw new DomainError("validation", "Neighbouring task isn't in that column");
    return row.sortKey;
  };

  if (position.afterId || position.beforeId) {
    const after = position.afterId ? await neighbour(position.afterId) : null;
    const before = position.beforeId ? await neighbour(position.beforeId) : null;
    if (after && before && after >= before) throw new DomainError("validation", "Neighbours are out of order");
    return generateKeyBetween(after, before);
  }

  const [last] = await tx
    .select({ sortKey: tasks.sortKey })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.statusId, statusId), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.sortKey))
    .limit(1);
  return generateKeyBetween(last?.sortKey ?? null, null);
}

export async function createTask(db: Db, ctx: ActorContext, projectKey: string, input: unknown): Promise<TaskDto> {
  assertCanWrite(ctx);
  const data = parseInput(createTaskInput, input);

  return db.transaction(async (tx) => {
    // Bumping the counter locks the project row, so numbers are unique and gap-free per project.
    const [project] = await tx
      .update(projects)
      .set({ taskSeq: sql`${projects.taskSeq} + 1` })
      .where(and(eq(projects.orgId, ctx.orgId), eq(projects.key, projectKey.toUpperCase())))
      .returning({ id: projects.id, key: projects.key, taskSeq: projects.taskSeq });
    if (!project) throw new DomainError("not_found", `Project ${projectKey} not found`);

    let status: StatusRow | undefined;
    if (data.statusId) {
      status = await findStatus(tx, project.id, data.statusId);
    } else {
      const rows = await tx.select().from(statuses).where(eq(statuses.projectId, project.id)).orderBy(asc(statuses.position));
      status = rows.find((s) => s.category === "todo") ?? rows[0];
    }
    if (!status) throw new DomainError("validation", "Project has no statuses");

    const assigneeIds = [...new Set(data.assigneeIds ?? [])];
    await assertActorsInOrg(tx, ctx.orgId, assigneeIds);
    if (data.parentId) await assertParent(tx, ctx.orgId, data.parentId);

    const [task] = await tx
      .insert(tasks)
      .values({
        orgId: ctx.orgId,
        projectId: project.id,
        number: project.taskSeq,
        title: data.title,
        description: data.description ?? null,
        statusId: status.id,
        priority: data.priority ?? 0,
        parentId: data.parentId ?? null,
        sortKey: await sortKeyFor(tx, project.id, status.id),
        creatorId: ctx.actorId,
        completedAt: CLOSED.includes(status.category) ? new Date() : null,
      })
      .returning();
    if (!task) throw new Error("Failed to create task");

    if (assigneeIds.length > 0) {
      await tx
        .insert(taskAssignees)
        .values(assigneeIds.map((actorId) => ({ taskId: task.id, actorId, assignedBy: ctx.actorId })));
      await notify(tx, ctx, task.id, assigneeIds.map((recipientId) => ({ recipientId, kind: "assigned" as const })));
    }

    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.created",
      changes: { title: task.title, statusId: status.id, assigneeIds },
    });

    return toTaskDto(task, project.key, assigneeIds);
  });
}

export async function listTasks(db: Db, orgId: string, projectKey: string): Promise<TaskDto[]> {
  const rows = await db
    .select({ task: tasks, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(projects.orgId, orgId), eq(projects.key, projectKey.toUpperCase()), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.sortKey), asc(tasks.id));
  const assignees = await assigneesByTask(
    db,
    rows.map((r) => r.task.id),
  );
  return rows.map((r) => toTaskDto(r.task, r.projectKey, assignees.get(r.task.id) ?? []));
}

/** The task row and its project key; not_found for unknown or deleted tasks. */
export async function findTask(db: Db | Tx, orgId: string, taskKey: string) {
  const parsed = parseTaskKey(taskKey);
  if (!parsed) throw new DomainError("not_found", `Task ${taskKey} not found`);
  const [row] = await db
    .select({ task: tasks, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.orgId, orgId),
        eq(projects.key, parsed.projectKey),
        eq(tasks.number, parsed.number),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new DomainError("not_found", `Task ${taskKey} not found`);
  return row;
}

export async function getTask(db: Db, orgId: string, taskKey: string): Promise<TaskDto> {
  const { task, projectKey } = await findTask(db, orgId, taskKey);
  const assignees = await assigneesByTask(db, [task.id]);
  return toTaskDto(task, projectKey, assignees.get(task.id) ?? []);
}

export async function updateTask(db: Db, ctx: ActorContext, taskKey: string, input: unknown): Promise<TaskDto> {
  assertCanWrite(ctx);
  const data: UpdateTaskInput = parseInput(updateTaskInput, input);

  return db.transaction(async (tx) => {
    const { task, projectKey } = await findTask(tx, ctx.orgId, taskKey);
    const patch: Partial<typeof tasks.$inferInsert> = {};
    const changes: Record<string, [unknown, unknown]> = {};
    const track = <K extends keyof TaskRow>(field: K, value: TaskRow[K]) => {
      if (task[field] === value) return;
      patch[field] = value;
      changes[field] = [task[field], value];
    };

    if (data.title !== undefined) track("title", data.title);
    if (data.description !== undefined) track("description", data.description);
    if (data.priority !== undefined) track("priority", data.priority);
    if (data.parentId !== undefined) {
      if (data.parentId) await assertParent(tx, ctx.orgId, data.parentId, task.id);
      track("parentId", data.parentId);
    }

    // A position move wins over a bare status change; both re-sort the task.
    const targetStatusId = data.position?.statusId ?? data.statusId;
    if (targetStatusId !== undefined) {
      const status = await findStatus(tx, task.projectId, targetStatusId);
      if (status.id !== task.statusId || data.position) {
        track("statusId", status.id);
        patch.sortKey = await sortKeyFor(tx, task.projectId, status.id, data.position);
      }
      if (status.id !== task.statusId) {
        const [previous] = await tx.select().from(statuses).where(eq(statuses.id, task.statusId)).limit(1);
        const wasClosed = previous ? CLOSED.includes(previous.category) : false;
        const isClosed = CLOSED.includes(status.category);
        if (isClosed && !wasClosed) patch.completedAt = new Date();
        if (!isClosed && wasClosed) patch.completedAt = null;
      }
    }

    let assigneeIds = (await assigneesByTask(tx, [task.id])).get(task.id) ?? [];
    if (data.assigneeIds !== undefined) {
      const next = [...new Set(data.assigneeIds)];
      await assertActorsInOrg(tx, ctx.orgId, next);
      const added = next.filter((id) => !assigneeIds.includes(id));
      const removed = assigneeIds.filter((id) => !next.includes(id));
      if (removed.length > 0) {
        await tx
          .delete(taskAssignees)
          .where(and(eq(taskAssignees.taskId, task.id), inArray(taskAssignees.actorId, removed)));
      }
      if (added.length > 0) {
        await tx
          .insert(taskAssignees)
          .values(added.map((actorId) => ({ taskId: task.id, actorId, assignedBy: ctx.actorId })));
        await notify(tx, ctx, task.id, added.map((recipientId) => ({ recipientId, kind: "assigned" as const })));
      }
      if (added.length > 0 || removed.length > 0) changes.assigneeIds = [assigneeIds, next];
      assigneeIds = next;
    }

    const touched = Object.keys(patch).length > 0 || changes.assigneeIds !== undefined;
    if (!touched) return toTaskDto(task, projectKey, assigneeIds);

    const [updated] = await tx
      .update(tasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();
    if (!updated) throw new Error("Failed to update task");

    // Pure reordering isn't worth an activity entry.
    if (Object.keys(changes).length > 0) {
      await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.updated", changes });
    }
    return toTaskDto(updated, projectKey, assigneeIds);
  });
}

export async function deleteTask(db: Db, ctx: ActorContext, taskKey: string): Promise<void> {
  assertCanWrite(ctx);
  await db.transaction(async (tx) => {
    const { task } = await findTask(tx, ctx.orgId, taskKey);
    await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, task.id));
    await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.deleted" });
  });
}
