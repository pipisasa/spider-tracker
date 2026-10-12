import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { aliasedTable, and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { assertCanWrite, inScope, orgIdOf, projectScope, type ActorContext, type ProjectScope, type Viewer } from "./access";
import { recordActivity } from "./activity";
import { publish } from "./events";
import { notify } from "./inbox";
import type { Priority, TaskDto } from "./contracts";
import { DomainError } from "./errors";
import { createTaskInput, parseTaskKey, updateTaskInput, type UpdateTaskInput } from "./schemas";
import { parseInput } from "./validate";

const { actors, projects, statuses, tags, taskAssignees, taskTags, tasks } = schema;

type TaskRow = typeof tasks.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

const CLOSED: StatusRow["category"][] = ["done", "canceled"];

interface TaskLinks {
  assigneeIds: string[];
  tagIds: string[];
  parentKey: string | null;
}

function toTaskDto(row: TaskRow, projectKey: string, { assigneeIds, tagIds, parentKey }: TaskLinks): TaskDto {
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
    parentKey: row.parentId ? parentKey : null,
    sortKey: row.sortKey,
    assigneeIds,
    tagIds,
    creatorId: row.creatorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Assignees, tags and parent key of each task. */
async function linksByTask(db: Db | Tx, taskIds: string[]) {
  const map = new Map<string, TaskLinks>(taskIds.map((id) => [id, { assigneeIds: [], tagIds: [], parentKey: null }]));
  if (taskIds.length === 0) return map;
  const [assigneeRows, tagRows] = await Promise.all([
    db
      .select({ taskId: taskAssignees.taskId, actorId: taskAssignees.actorId })
      .from(taskAssignees)
      .where(inArray(taskAssignees.taskId, taskIds))
      .orderBy(asc(taskAssignees.assignedAt)),
    db
      .select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(taskTags.taskId, taskIds))
      .orderBy(asc(tags.name)),
  ]);
  for (const row of assigneeRows) map.get(row.taskId)?.assigneeIds.push(row.actorId);
  for (const row of tagRows) map.get(row.taskId)?.tagIds.push(row.tagId);

  const parent = aliasedTable(tasks, "parent");
  const parentRows = await db
    .select({ taskId: tasks.id, number: parent.number, projectKey: projects.key })
    .from(tasks)
    .innerJoin(parent, and(eq(tasks.parentId, parent.id), isNull(parent.deletedAt)))
    .innerJoin(projects, eq(parent.projectId, projects.id))
    .where(inArray(tasks.id, taskIds));
  for (const row of parentRows) {
    const links = map.get(row.taskId);
    if (links) links.parentKey = `${row.projectKey}-${row.number}`;
  }
  return map;
}

const noLinks: TaskLinks = { assigneeIds: [], tagIds: [], parentKey: null };

async function assertTagsInOrg(tx: Tx, orgId: string, tagIds: string[]) {
  if (tagIds.length === 0) return;
  const rows = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.orgId, orgId), inArray(tags.id, tagIds)));
  if (rows.length !== tagIds.length) throw new DomainError("validation", "Tags must belong to this organization");
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

const MAX_TASK_DEPTH = 20;

/** The parent must exist in the organization, and must not be the task itself or one of its sub-tasks. */
async function assertParent(tx: Tx, orgId: string, scope: ProjectScope, parentId: string, selfId?: string) {
  if (parentId === selfId) throw new DomainError("validation", "A task can't be its own parent");
  let current: string | null = parentId;
  for (let depth = 0; current; depth++) {
    if (depth >= MAX_TASK_DEPTH) throw new DomainError("validation", `Sub-tasks can nest at most ${MAX_TASK_DEPTH} levels`);
    const [row] = await tx
      .select({ id: tasks.id, parentId: tasks.parentId, projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.id, current), eq(tasks.orgId, orgId), isNull(tasks.deletedAt)))
      .limit(1);
    if (!row || (depth === 0 && !inScope(scope, row.projectId))) throw new DomainError("validation", depth === 0 ? "Parent task not found" : "Parent chain is broken");
    if (selfId && row.parentId === selfId) {
      throw new DomainError("validation", "That task is a sub-task of this one; it can't also be its parent");
    }
    current = row.parentId;
  }
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
    if (!project || !inScope(await projectScope(tx, ctx), project.id)) {
      throw new DomainError("not_found", `Project ${projectKey} not found`);
    }

    let status: StatusRow | undefined;
    if (data.statusId) {
      status = await findStatus(tx, project.id, data.statusId);
    } else {
      const rows = await tx.select().from(statuses).where(eq(statuses.projectId, project.id)).orderBy(asc(statuses.position));
      status = rows.find((s) => s.category === "todo") ?? rows[0];
    }
    if (!status) throw new DomainError("validation", "Project has no statuses");

    const assigneeIds = [...new Set(data.assigneeIds ?? [])];
    const tagIds = [...new Set(data.tagIds ?? [])];
    await assertActorsInOrg(tx, ctx.orgId, assigneeIds);
    await assertTagsInOrg(tx, ctx.orgId, tagIds);
    if (data.parentId) await assertParent(tx, ctx.orgId, await projectScope(tx, ctx), data.parentId);

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
    if (tagIds.length > 0) await tx.insert(taskTags).values(tagIds.map((tagId) => ({ taskId: task.id, tagId })));

    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.created",
      changes: { title: task.title, statusId: status.id, assigneeIds, ...(tagIds.length ? { tagIds } : {}) },
    });

    await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: project.key, taskKey: `${project.key}-${task.number}` });
    const parentKey = task.parentId ? ((await linksByTask(tx, [task.id])).get(task.id)?.parentKey ?? null) : null;
    return toTaskDto(task, project.key, { assigneeIds, tagIds, parentKey });
  });
}

export async function listTasks(db: Db, viewer: Viewer, projectKey: string): Promise<TaskDto[]> {
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select({ task: tasks, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.orgId, orgIdOf(viewer)),
        eq(projects.key, projectKey.toUpperCase()),
        isNull(tasks.deletedAt),
        scope ? inArray(projects.id, [...scope]) : undefined,
      ),
    )
    .orderBy(asc(tasks.sortKey), asc(tasks.id));
  const links = await linksByTask(
    db,
    rows.map((r) => r.task.id),
  );
  return rows.map((r) => toTaskDto(r.task, r.projectKey, links.get(r.task.id) ?? noLinks));
}

/** The task row and its project key; not_found for unknown or deleted tasks, and tasks outside the viewer's scope. */
export async function findTask(db: Db | Tx, viewer: Viewer, taskKey: string) {
  const parsed = parseTaskKey(taskKey);
  if (!parsed) throw new DomainError("not_found", `Task ${taskKey} not found`);
  const [row] = await db
    .select({ task: tasks, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.orgId, orgIdOf(viewer)),
        eq(projects.key, parsed.projectKey),
        eq(tasks.number, parsed.number),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1);
  if (!row || !inScope(await projectScope(db, viewer), row.task.projectId)) throw new DomainError("not_found", `Task ${taskKey} not found`);
  return row;
}

export async function getTask(db: Db, viewer: Viewer, taskKey: string): Promise<TaskDto> {
  const { task, projectKey } = await findTask(db, viewer, taskKey);
  const links = await linksByTask(db, [task.id]);
  return toTaskDto(task, projectKey, links.get(task.id) ?? noLinks);
}

/** Direct sub-tasks of a task (any project), oldest first. */
export async function listSubtasks(db: Db, viewer: Viewer, taskKey: string): Promise<TaskDto[]> {
  const { task } = await findTask(db, viewer, taskKey);
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select({ task: tasks, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.parentId, task.id), isNull(tasks.deletedAt), scope ? inArray(tasks.projectId, [...scope]) : undefined))
    .orderBy(asc(tasks.createdAt));
  const links = await linksByTask(
    db,
    rows.map((r) => r.task.id),
  );
  return rows.map((r) => toTaskDto(r.task, r.projectKey, links.get(r.task.id) ?? noLinks));
}

export async function updateTask(db: Db, ctx: ActorContext, taskKey: string, input: unknown): Promise<TaskDto> {
  assertCanWrite(ctx);
  const data: UpdateTaskInput = parseInput(updateTaskInput, input);

  return db.transaction(async (tx) => {
    const { task, projectKey } = await findTask(tx, ctx, taskKey);
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
      if (data.parentId) await assertParent(tx, ctx.orgId, await projectScope(tx, ctx), data.parentId, task.id);
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

    const current = (await linksByTask(tx, [task.id])).get(task.id) ?? noLinks;
    let assigneeIds = current.assigneeIds;
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

    let tagIds = current.tagIds;
    if (data.tagIds !== undefined) {
      const next = [...new Set(data.tagIds)];
      await assertTagsInOrg(tx, ctx.orgId, next);
      const added = next.filter((id) => !tagIds.includes(id));
      const removed = tagIds.filter((id) => !next.includes(id));
      if (removed.length > 0) {
        await tx.delete(taskTags).where(and(eq(taskTags.taskId, task.id), inArray(taskTags.tagId, removed)));
      }
      if (added.length > 0) await tx.insert(taskTags).values(added.map((tagId) => ({ taskId: task.id, tagId })));
      if (added.length > 0 || removed.length > 0) changes.tagIds = [tagIds, next];
      tagIds = next;
    }

    const touched = Object.keys(patch).length > 0 || changes.assigneeIds !== undefined || changes.tagIds !== undefined;
    if (!touched) return toTaskDto(task, projectKey, { assigneeIds, tagIds, parentKey: current.parentKey });

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
    await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey, taskKey: `${projectKey}-${task.number}` });
    const parentKey = updated.parentId ? ((await linksByTask(tx, [updated.id])).get(updated.id)?.parentKey ?? null) : null;
    return toTaskDto(updated, projectKey, { assigneeIds, tagIds, parentKey });
  });
}

export async function deleteTask(db: Db, ctx: ActorContext, taskKey: string): Promise<void> {
  assertCanWrite(ctx);
  await db.transaction(async (tx) => {
    const { task, projectKey } = await findTask(tx, ctx, taskKey);
    const now = new Date();
    await tx.update(tasks).set({ deletedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
    await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.deleted" });
    await publish(tx, { type: "task.deleted", orgId: ctx.orgId, projectKey, taskKey: `${projectKey}-${task.number}` });

    // Sub-tasks become top-level tasks rather than hanging off a deleted parent (ST-9).
    const children = await tx
      .update(tasks)
      .set({ parentId: null, updatedAt: now })
      .where(and(eq(tasks.parentId, task.id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id, number: tasks.number, projectId: tasks.projectId });
    if (children.length === 0) return;
    const keys = await tx
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(inArray(projects.id, [...new Set(children.map((c) => c.projectId))]));
    const keyOf = new Map(keys.map((p) => [p.id, p.key]));
    for (const child of children) {
      await recordActivity(tx, ctx, {
        entityType: "task",
        entityId: child.id,
        action: "task.updated",
        changes: { parentId: [task.id, null] },
      });
      const childProjectKey = keyOf.get(child.projectId);
      if (childProjectKey) {
        await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: childProjectKey, taskKey: `${childProjectKey}-${child.number}` });
      }
    }
  });
}
