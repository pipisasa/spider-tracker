import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { aliasedTable, and, asc, desc, eq, exists, inArray, isNull, lt, ne, not, or, sql, type SQL } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { assertCanWrite, inScope, orgIdOf, projectScope, type ActorContext, type ProjectScope, type Viewer } from "./access";
import { recordActivity } from "./activity";
import { publish } from "./events";
import { notify } from "./inbox";
import type {
  BulkTaskResultDto,
  BulkUpdateTasksResponse,
  MilestoneRefDto,
  Priority,
  ProjectDetailDto,
  ReleaseRefDto,
  StatusCategory,
  SubtaskDto,
  TaskDto,
  TaskKind,
  TaskShippingDto,
} from "./contracts";
import { DomainError } from "./errors";
import { listMembers } from "./organizations";
import { getProject } from "./projects";
import {
  DATES_OUT_OF_ORDER,
  MAX_BULK_TASKS,
  bulkUpdateTasksInput,
  createTaskInput,
  datesInOrder,
  normalizeHandle,
  parseTaskKey,
  taskListFilters,
  todayUtc,
  updateTaskInput,
  type CreateTaskInput,
  type UpdateTaskInput,
} from "./schemas";
import { assertMilestoneFor, effectiveMilestones, milestoneTasksOnDelete, settleMilestones } from "./milestone-membership";
import { applyReleaseTransition, releaseTasksOnDelete } from "./shipping";
import { allStatuses, matchStatuses, unknownStatusMessage, workflowOf } from "./statuses";
import { parseInput } from "./validate";

const { actors, agents, projects, statuses, tags, taskAssignees, taskTags, tasks } = schema;

type TaskRow = typeof tasks.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

const CLOSED: StatusRow["category"][] = ["done", "canceled"];

interface TaskLinks {
  assigneeIds: string[];
  tagIds: string[];
  parentKey: string | null;
  /** The parent is outside the viewer's scope: neither its key nor its id is shown. */
  parentHidden: boolean;
  /** The task's status category; null when unknown (shipping is then left out). */
  category: StatusCategory | null;
  /** The release it is in, when the viewer can see it (ST-93). */
  release: ReleaseRefDto | null;
  /** In a release outside the viewer's scope: its id isn't shown. */
  releaseHidden: boolean;
  /** The milestone it belongs to, its own or inherited (ST-96), when the viewer can see it. */
  milestone: MilestoneRefDto | null;
}

/** Where a task's code is (ST-93); see TaskDto.shipping. */
function shippingOf(row: TaskRow, { category, release, releaseHidden }: TaskLinks): TaskShippingDto | null {
  if (row.kind !== "task") return null;
  if (row.shippedAt) return { state: "shipped", release };
  if (row.releaseId && (release || releaseHidden)) return { state: "in_release", release };
  if (category !== "done") return null;
  return { state: row.noCode ? "no_code" : "not_in_release", release: null };
}

function toTaskDto(row: TaskRow, projectKey: string, links: TaskLinks): TaskDto {
  const { assigneeIds, tagIds, parentKey, parentHidden } = links;
  return {
    id: row.id,
    key: `${projectKey}-${row.number}`,
    number: row.number,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    description: row.description,
    statusId: row.statusId,
    priority: row.priority as Priority,
    parentId: parentHidden ? null : row.parentId,
    parentKey: row.parentId ? parentKey : null,
    sortKey: row.sortKey,
    startDate: row.startDate,
    targetDate: row.targetDate,
    assigneeIds,
    tagIds,
    creatorId: row.creatorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    subtasks: null,
    releaseId: links.release ? row.releaseId : null,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    noCode: row.noCode,
    shipping: shippingOf(row, links),
    milestoneId: row.milestoneId,
    milestone: links.milestone,
  };
}

const emptyLinks = (): TaskLinks => ({
  assigneeIds: [],
  tagIds: [],
  parentKey: null,
  parentHidden: false,
  category: null,
  release: null,
  releaseHidden: false,
  milestone: null,
});

/**
 * Assignees, tags, parent key, status category and release of each task; parents and releases
 * outside `scope` are hidden (no key, no id).
 */
async function linksByTask(db: Db | Tx, scope: ProjectScope, taskIds: string[]) {
  const map = new Map<string, TaskLinks>(taskIds.map((id) => [id, emptyLinks()]));
  if (taskIds.length === 0) return map;
  // One after the other: inside a transaction they share its connection.
  const assigneeRows = await db
    .select({ taskId: taskAssignees.taskId, actorId: taskAssignees.actorId })
    .from(taskAssignees)
    .where(inArray(taskAssignees.taskId, taskIds))
    .orderBy(asc(taskAssignees.assignedAt));
  const tagRows = await db
    .select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(inArray(taskTags.taskId, taskIds))
    .orderBy(asc(tags.name));
  for (const row of assigneeRows) map.get(row.taskId)?.assigneeIds.push(row.actorId);
  for (const row of tagRows) map.get(row.taskId)?.tagIds.push(row.tagId);

  const parent = aliasedTable(tasks, "parent");
  const parentRows = await db
    .select({ taskId: tasks.id, number: parent.number, projectId: parent.projectId, projectKey: projects.key })
    .from(tasks)
    .innerJoin(parent, and(eq(tasks.parentId, parent.id), isNull(parent.deletedAt)))
    .innerJoin(projects, eq(parent.projectId, projects.id))
    .where(inArray(tasks.id, taskIds));
  for (const row of parentRows) {
    const links = map.get(row.taskId);
    if (!links) continue;
    if (inScope(scope, row.projectId)) links.parentKey = `${row.projectKey}-${row.number}`;
    else links.parentHidden = true;
  }

  // The status category, and the release with its status (ST-93).
  const shippingRows = await db
    .select({ taskId: tasks.id, category: statuses.category, releaseId: tasks.releaseId })
    .from(tasks)
    .innerJoin(statuses, eq(tasks.statusId, statuses.id))
    .where(inArray(tasks.id, taskIds));
  const releaseIds = [...new Set(shippingRows.flatMap((r) => (r.releaseId ? [r.releaseId] : [])))];
  const releaseRows = releaseIds.length
    ? await db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          projectId: tasks.projectId,
          projectKey: projects.key,
          status: { id: statuses.id, name: statuses.name, category: statuses.category },
        })
        .from(tasks)
        .innerJoin(statuses, eq(tasks.statusId, statuses.id))
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(and(inArray(tasks.id, releaseIds), isNull(tasks.deletedAt)))
    : [];
  for (const row of shippingRows) {
    const links = map.get(row.taskId);
    if (!links) continue;
    links.category = row.category;
    const release = releaseRows.find((r) => r.id === row.releaseId);
    if (!release) continue;
    if (!inScope(scope, release.projectId)) {
      links.releaseHidden = true;
      continue;
    }
    links.release = { id: release.id, key: `${release.projectKey}-${release.number}`, title: release.title, status: release.status };
  }

  // The milestone, the task's own or its nearest ancestor's (ST-96).
  const memberships = await effectiveMilestones(db, taskIds);
  const milestoneIds = [...new Set([...memberships.values()].map((m) => m.milestoneId))];
  const milestoneRows = milestoneIds.length
    ? await db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          projectId: tasks.projectId,
          projectKey: projects.key,
          status: { id: statuses.id, name: statuses.name, category: statuses.category },
        })
        .from(tasks)
        .innerJoin(statuses, eq(tasks.statusId, statuses.id))
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(and(inArray(tasks.id, milestoneIds), isNull(tasks.deletedAt)))
    : [];
  for (const [taskId, membership] of memberships) {
    const links = map.get(taskId);
    const milestone = milestoneRows.find((m) => m.id === membership.milestoneId);
    if (!links || !milestone || !inScope(scope, milestone.projectId)) continue;
    links.milestone = {
      id: milestone.id,
      key: `${milestone.projectKey}-${milestone.number}`,
      title: milestone.title,
      status: milestone.status,
      inherited: membership.inherited,
    };
  }
  return map;
}

/** Task rows (with their project keys) as DTOs for `viewer`, with links and sub-task counts. */
export async function toTaskDtos(db: Db | Tx, scope: ProjectScope, rows: { task: TaskRow; projectKey: string }[]): Promise<TaskDto[]> {
  const links = await linksByTask(
    db,
    scope,
    rows.map((r) => r.task.id),
  );
  return withProgress(
    db,
    scope,
    rows.map((r) => toTaskDto(r.task, r.projectKey, links.get(r.task.id) ?? emptyLinks())),
  );
}

/** Fills `subtasks` ({ done, total } of the direct children inside `scope`) in one grouped query. */
async function withProgress(db: Db | Tx, scope: ProjectScope, dtos: TaskDto[]): Promise<TaskDto[]> {
  if (dtos.length === 0) return dtos;
  const child = aliasedTable(tasks, "child");
  const rows = await db
    .select({
      parentId: child.parentId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`(count(*) filter (where ${statuses.category} in ('done', 'canceled')))::int`,
    })
    .from(child)
    .innerJoin(statuses, eq(child.statusId, statuses.id))
    .where(
      and(
        inArray(
          child.parentId,
          dtos.map((t) => t.id),
        ),
        isNull(child.deletedAt),
        scope ? inArray(child.projectId, [...scope]) : undefined,
      ),
    )
    .groupBy(child.parentId);
  const byParent = new Map(rows.map((r) => [r.parentId, { done: r.done, total: r.total }]));
  return dtos.map((t) => ({ ...t, subtasks: byParent.get(t.id) ?? null }));
}

async function assertTagsInOrg(tx: Tx, orgId: string, tagIds: string[]) {
  if (tagIds.length === 0) return;
  const rows = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.orgId, orgId), inArray(tags.id, tagIds)));
  if (rows.length !== tagIds.length) throw new DomainError("validation", "Tags must belong to this organization");
}

/** A status of the project's workflow for `kind` (ST-90): another project's, or another kind's, is refused. */
async function findStatus(tx: Tx, projectId: string, kind: TaskKind, statusId: string) {
  const [status] = await tx
    .select()
    .from(statuses)
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, projectId)))
    .limit(1);
  if (!status) throw new DomainError("validation", "Status doesn't belong to this project");
  if (status.kind !== kind) {
    throw new DomainError("validation", `Status "${status.name}" is in the ${status.kind} workflow; a ${kind} needs a status of the ${kind} workflow`);
  }
  return status;
}

async function assertActorsInOrg(tx: Tx, orgId: string, actorIds: string[]) {
  if (actorIds.length === 0) return;
  const unique = [...new Set(actorIds)];
  const rows = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(
      and(eq(actors.orgId, orgId), inArray(actors.id, unique), isNull(actors.deactivatedAt), ne(actors.type, "integration")),
    );
  if (rows.length !== unique.length) throw new DomainError("validation", "Assignees must be members of this organization");
}

const MAX_TASK_DEPTH = 20;

/** The parent must exist in the organization, and must not be the task itself or one of its sub-tasks. */
async function assertParent(tx: Tx, orgId: string, scope: ProjectScope, parentId: string, selfId?: string) {
  if (parentId === selfId) throw new DomainError("validation", "A task can't be its own parent");
  // Serialise parent changes per organization until commit: otherwise two concurrent re-parents
  // (A under B, B under A) each pass the check against the other's uncommitted state and form a cycle.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"task-parent:" + orgId}))`);
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
  return db.transaction((tx) => createTaskIn(tx, ctx, projectKey, data));
}

/** The body of createTask inside a transaction, shared with createRelease (core only; callers check write access). */
export async function createTaskIn(tx: Tx, ctx: ActorContext, projectKey: string, data: CreateTaskInput): Promise<TaskDto> {
  // Bumping the counter locks the project row, so numbers are unique and gap-free per project.
  const [project] = await tx
    .update(projects)
    .set({ taskSeq: sql`${projects.taskSeq} + 1` })
    .where(and(eq(projects.orgId, ctx.orgId), eq(projects.key, projectKey.toUpperCase())))
    .returning({ id: projects.id, key: projects.key, taskSeq: projects.taskSeq, archivedAt: projects.archivedAt });
  const scope = await projectScope(tx, ctx);
  if (!project || !inScope(scope, project.id)) {
    throw new DomainError("not_found", `Project ${projectKey} not found`);
  }
  // Throwing rolls back the counter bump.
  if (project.archivedAt) throw new DomainError("validation", `Project ${project.key} is archived`);

  const kind = data.kind ?? "task";
  let status: StatusRow | undefined;
  if (data.statusId) {
    status = await findStatus(tx, project.id, kind, data.statusId);
  } else {
    // The kind's first todo status, else its first status.
    const rows = await tx
      .select()
      .from(statuses)
      .where(and(eq(statuses.projectId, project.id), eq(statuses.kind, kind)))
      .orderBy(asc(statuses.position));
    status = rows.find((s) => s.category === "todo") ?? rows[0];
  }
  if (!status) throw new DomainError("validation", `Project has no ${kind} statuses`);

  const assigneeIds = [...new Set(data.assigneeIds ?? [])];
  const tagIds = [...new Set(data.tagIds ?? [])];
  await assertActorsInOrg(tx, ctx.orgId, assigneeIds);
  await assertTagsInOrg(tx, ctx.orgId, tagIds);
  if (data.parentId) await assertParent(tx, ctx.orgId, scope, data.parentId);
  if (data.milestoneId) await assertMilestoneFor(tx, { kind, projectId: project.id, label: "the new task" }, data.milestoneId);

  const [task] = await tx
    .insert(tasks)
    .values({
      orgId: ctx.orgId,
      projectId: project.id,
      kind,
      number: project.taskSeq,
      title: data.title,
      description: data.description ?? null,
      statusId: status.id,
      priority: data.priority ?? 0,
      parentId: data.parentId ?? null,
      startDate: data.startDate ?? null,
      targetDate: data.targetDate ?? null,
      milestoneId: data.milestoneId ?? null,
      sortKey: await sortKeyFor(tx, project.id, status.id),
      creatorId: ctx.actorId,
      completedAt: CLOSED.includes(status.category) ? new Date() : null,
      // A release created as Released has shipped (ST-93).
      shippedAt: kind === "release" && status.category === "done" ? new Date() : null,
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
    changes: {
      title: task.title,
      ...(kind !== "task" ? { kind } : {}),
      statusId: status.id,
      assigneeIds,
      ...(tagIds.length ? { tagIds } : {}),
      ...(task.startDate ? { startDate: task.startDate } : {}),
      ...(task.targetDate ? { targetDate: task.targetDate } : {}),
      ...(task.milestoneId ? { milestoneId: task.milestoneId } : {}),
    },
  });

  await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: project.key, taskKey: `${project.key}-${task.number}` });
  const links = (await linksByTask(tx, scope, [task.id])).get(task.id) ?? emptyLinks();
  return toTaskDto(task, project.key, { ...links, assigneeIds, tagIds });
}

/**
 * The actors "mine" stands for, as a subquery: the viewer's person (the viewer, or the owner of an
 * agent viewer) and every agent that person owns, deactivated ones too, within the organization.
 */
function mineActorIds(db: Db, viewer: ActorContext) {
  const self = aliasedTable(agents, "self");
  const owner = db.select({ id: self.ownerId }).from(self).where(eq(self.actorId, viewer.actorId));
  const person = sql`coalesce(${owner}, ${viewer.actorId}::uuid)`;
  return db
    .select({ id: actors.id })
    .from(actors)
    .leftJoin(agents, eq(agents.actorId, actors.id))
    .where(and(eq(actors.orgId, viewer.orgId), or(eq(actors.id, person), eq(agents.ownerId, person))));
}

/** SQL conditions for the list filters of `project`; unknown statuses, members and tags are validation errors. */
async function filterConditions(db: Db, viewer: Viewer, project: ProjectDetailDto, filters: unknown): Promise<SQL[]> {
  const data = parseInput(taskListFilters, filters);
  const where: SQL[] = [];
  // Without a kind, names and categories match in every workflow ("done" finds done tasks and milestones).
  const kind = data.kind ?? "all";
  const known = kind === "all" ? allStatuses(project) : workflowOf(project, kind);
  if (data.kind) where.push(eq(tasks.kind, data.kind));

  if (data.status?.length) {
    const ids = new Set<string>();
    for (const value of data.status) {
      const byId = known.filter((s) => s.id === value);
      const matched = byId.length ? byId : matchStatuses(project, value, kind);
      if (matched.length === 0) throw new DomainError("validation", unknownStatusMessage(project, value, kind));
      for (const s of matched) ids.add(s.id);
    }
    where.push(inArray(tasks.statusId, [...ids]));
  }

  if (data.assignee?.length) {
    // Deactivated actors too, so tasks still assigned to them can be found (ST-65).
    const rows = await listMembers(db, orgIdOf(viewer), { includeDeactivated: true });
    const ids = new Set<string>();
    let none = false;
    let mine = false;
    for (const raw of data.assignee) {
      const handle = normalizeHandle(raw);
      if (handle === "none") {
        none = true;
      } else if (handle === "me" || handle === "mine") {
        if (typeof viewer === "string") throw new DomainError("validation", `"${handle}" needs a signed-in member`);
        if (handle === "me") ids.add(viewer.actorId);
        else mine = true;
      } else {
        const actor = rows.find((a) => a.id === raw || a.handle.toLowerCase() === handle);
        if (!actor) {
          throw new DomainError(
            "validation",
            `Unknown member "${raw}". Valid handles: me, mine, none, ${rows.map((a) => a.handle).join(", ")}`,
          );
        }
        ids.add(actor.id);
      }
    }
    const assigned = (actorIds?: string[] | ReturnType<typeof mineActorIds>) =>
      exists(
        db
          .select({ one: sql`1` })
          .from(taskAssignees)
          .where(and(eq(taskAssignees.taskId, tasks.id), actorIds ? inArray(taskAssignees.actorId, actorIds) : undefined)),
      );
    const options = [
      ids.size ? assigned([...ids]) : undefined,
      mine && typeof viewer !== "string" ? assigned(mineActorIds(db, viewer)) : undefined,
      none ? not(assigned()) : undefined,
    ];
    const condition = or(...options);
    if (condition) where.push(condition);
  }

  const names = [...new Set((data.tags ?? []).map((n) => n.replace(/^#/, "").trim().toLowerCase()))].filter(Boolean);
  if (names.length) {
    const orgId = orgIdOf(viewer);
    // Names are unique per organization regardless of case (the lower(name) index).
    const rows = await db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.orgId, orgId), inArray(sql`lower(${tags.name})`, names)));
    const missing = names.find((name) => !rows.some((t) => t.name.toLowerCase() === name));
    if (missing !== undefined) {
      const existing = await db.select({ name: tags.name }).from(tags).where(eq(tags.orgId, orgId)).orderBy(asc(tags.name));
      throw new DomainError("validation", `Unknown tag "${missing}". Existing tags: ${existing.map((t) => t.name).join(", ") || "none"}`);
    }
    const ids = rows.map((t) => t.id);
    const tagged = db.select({ id: taskTags.taskId }).from(taskTags).where(inArray(taskTags.tagId, ids));
    // "all": the task's rows among the tags must number as many as the tags.
    where.push(
      inArray(tasks.id, data.tagMatch === "any" ? tagged : tagged.groupBy(taskTags.taskId).having(sql`count(*) = ${ids.length}`)),
    );
  }

  if (data.priority?.length) where.push(inArray(tasks.priority, [...new Set(data.priority)]));
  if (data.q) where.push(sql`strpos(lower(${tasks.title}), ${data.q.toLowerCase()}) > 0`);
  if (data.parent) {
    const parent = await findTask(db, viewer, data.parent).catch((err: unknown) => {
      if (err instanceof DomainError && err.code === "not_found") throw new DomainError("validation", `Unknown parent task "${data.parent}"`);
      throw err;
    });
    where.push(eq(tasks.parentId, parent.task.id));
  }
  if (data.overdue) {
    // Today is the server's UTC date (todayUtc); closed means a done or canceled status.
    const open = known.filter((s) => !CLOSED.includes(s.category)).map((s) => s.id);
    where.push(lt(tasks.targetDate, todayUtc()), inArray(tasks.statusId, open));
  }
  return where;
}

/**
 * A project's tasks in board order, optionally filtered (see `taskListFilters`): any of the
 * statuses, assignees and priorities, all (or any, with `tagMatch: "any"`) of the tags, and
 * title text. A missing or out-of-scope project is not_found, filtered or not.
 */
export async function listTasks(db: Db, viewer: Viewer, projectKey: string, filters: unknown = {}): Promise<TaskDto[]> {
  const project = await getProject(db, viewer, projectKey);
  const conditions = await filterConditions(db, viewer, project, filters);
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt), ...conditions))
    .orderBy(asc(tasks.sortKey), asc(tasks.id));
  return toTaskDtos(
    db,
    scope,
    rows.map((task) => ({ task, projectKey: project.key })),
  );
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
  const scope = await projectScope(db, viewer);
  return (await toTaskDtos(db, scope, [{ task, projectKey }]))[0]!;
}

/** Direct sub-tasks of a task (any project), oldest first, with their own status. */
export async function listSubtasks(db: Db, viewer: Viewer, taskKey: string): Promise<SubtaskDto[]> {
  const { task } = await findTask(db, viewer, taskKey);
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select({ task: tasks, projectKey: projects.key, status: { id: statuses.id, name: statuses.name, category: statuses.category, color: statuses.color } })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(statuses, eq(tasks.statusId, statuses.id))
    .where(and(eq(tasks.parentId, task.id), isNull(tasks.deletedAt), scope ? inArray(tasks.projectId, [...scope]) : undefined))
    .orderBy(asc(tasks.createdAt));
  const dtos = await toTaskDtos(db, scope, rows);
  return dtos.map((dto, i) => ({ ...dto, status: rows[i]!.status }));
}

export async function updateTask(db: Db, ctx: ActorContext, taskKey: string, input: unknown): Promise<TaskDto> {
  assertCanWrite(ctx);
  const data: UpdateTaskInput = parseInput(updateTaskInput, input);
  return db.transaction(async (tx) => (await applyTaskUpdate(tx, ctx, await findTask(tx, ctx, taskKey), data)).task);
}

export type FoundTask = Awaited<ReturnType<typeof findTask>>;

export interface TaskUpdateOutcome {
  task: TaskDto;
  /** Whether anything was written (a pure re-sort counts). */
  changed: boolean;
}

/** Extras for applyTaskUpdate. */
export interface TaskUpdateOptions {
  /** Context added to the activity entry's changes (not a field change), e.g. the pull request that moved the task (ST-85). */
  activity?: Record<string, unknown>;
}

/**
 * Applies a validated update to a task found in `tx`: the body of updateTask, shared with updateTasks
 * and markDuplicate (core only; callers check write access and parse the input).
 */
export async function applyTaskUpdate(
  tx: Tx,
  ctx: ActorContext,
  { task, projectKey }: FoundTask,
  data: UpdateTaskInput,
  options: TaskUpdateOptions = {},
): Promise<TaskUpdateOutcome> {
  const scope = await projectScope(tx, ctx);
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
    if (data.parentId) await assertParent(tx, ctx.orgId, scope, data.parentId, task.id);
    track("parentId", data.parentId);
  }
  if (data.startDate !== undefined || data.targetDate !== undefined) {
    // Checked against the stored date the update leaves unchanged, too.
    const start = data.startDate === undefined ? task.startDate : data.startDate;
    const target = data.targetDate === undefined ? task.targetDate : data.targetDate;
    if (!datesInOrder(start, target)) throw new DomainError("validation", DATES_OUT_OF_ORDER);
    if (data.startDate !== undefined) track("startDate", data.startDate);
    if (data.targetDate !== undefined) track("targetDate", data.targetDate);
  }
  if (data.noCode !== undefined) {
    if (task.kind !== "task" && data.noCode) throw new DomainError("validation", `Only tasks have code to ship; ${projectKey}-${task.number} is a ${task.kind}`);
    track("noCode", data.noCode);
  }
  if (data.milestoneId !== undefined) {
    const label = `${projectKey}-${task.number}`;
    if (data.milestoneId) await assertMilestoneFor(tx, { kind: task.kind, projectId: task.projectId, label }, data.milestoneId);
    track("milestoneId", data.milestoneId);
  }
  // The milestone the task is in before the change, when the change may complete one (ST-96).
  const settles =
    task.kind === "task" &&
    [data.statusId, data.position, data.noCode, data.milestoneId, data.parentId].some((v) => v !== undefined);
  const milestoneBefore = settles ? (await effectiveMilestones(tx, [task.id])).get(task.id)?.milestoneId : undefined;

  // A position move wins over a bare status change; both re-sort the task.
  const targetStatusId = data.position?.statusId ?? data.statusId;
  if (targetStatusId !== undefined) {
    const status = await findStatus(tx, task.projectId, task.kind, targetStatusId);
    if (status.id !== task.statusId || data.position) {
      track("statusId", status.id);
      patch.sortKey = await sortKeyFor(tx, task.projectId, status.id, data.position);
    }
    if (status.id !== task.statusId) {
      const [previous] = await tx.select().from(statuses).where(eq(statuses.id, task.statusId)).limit(1);
      const wasClosed = previous ? CLOSED.includes(previous.category) : false;
      const isClosed = CLOSED.includes(status.category);
      const now = new Date();
      if (isClosed && !wasClosed) patch.completedAt = now;
      if (!isClosed && wasClosed) patch.completedAt = null;
      // A release marked Released ships its tasks; leaving Released or canceling undoes that (ST-93).
      if (task.kind === "release" && previous) {
        const shipped = await applyReleaseTransition(tx, ctx, scope, { ...task, key: `${projectKey}-${task.number}` }, previous.category, status.category, now);
        if (shipped !== undefined) patch.shippedAt = shipped;
      }
    }
  }

  const current = (await linksByTask(tx, scope, [task.id])).get(task.id) ?? emptyLinks();
  let assigneeIds = current.assigneeIds;
  if (data.assigneeIds !== undefined) {
    const next = [...new Set(data.assigneeIds)];
    const added = next.filter((id) => !assigneeIds.includes(id));
    // Only new assignees must be active members: a deactivated agent stays assigned
    // (deleteAgent keeps assignments) without blocking later updates (ST-38).
    await assertActorsInOrg(tx, ctx.orgId, added);
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
  if (!touched) {
    return { task: (await withProgress(tx, scope, [toTaskDto(task, projectKey, { ...current, assigneeIds, tagIds })]))[0]!, changed: false };
  }

  const [updated] = await tx
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .returning();
  if (!updated) throw new Error("Failed to update task");

  // Pure reordering isn't worth an activity entry.
  if (Object.keys(changes).length > 0) {
    await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.updated", changes: { ...changes, ...options.activity } });
  }
  await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey, taskKey: `${projectKey}-${task.number}` });
  // A finished task (or one leaving) may complete its milestone, old or new (ST-96).
  if (settles && Object.keys(changes).length > 0) {
    const milestoneAfter = (await effectiveMilestones(tx, [task.id])).get(task.id)?.milestoneId;
    await settleMilestones(tx, ctx.orgId, [milestoneBefore, milestoneAfter]);
  }
  const links = (await linksByTask(tx, scope, [updated.id])).get(updated.id) ?? emptyLinks();
  return {
    task: (await withProgress(tx, scope, [toTaskDto(updated, projectKey, { ...links, assigneeIds, tagIds })]))[0]!,
    changed: true,
  };
}

/** Thrown inside a dry run's transaction to roll it back once the outcome is known. */
const rollback = Symbol("dry run");

/** "spi-2" → "SPI-2"; anything that doesn't parse stays as given (and fails as not found). */
const normalizeTaskKey = (key: string) => {
  const parsed = parseTaskKey(key);
  return parsed ? `${parsed.projectKey}-${parsed.number}` : key;
};

/**
 * Updates several tasks at once (ST-106): the tasks named by `keys`, or those matching `filter` in
 * one project, at most MAX_BULK_TASKS (a filter matching more is a validation error and changes
 * nothing). Each task is updated in its own transaction with the same checks as updateTask, so
 * a task that is missing, outside the agent's scope or invalid for the change is reported as an
 * error without stopping the others. `dryRun` runs every update and rolls it back.
 */
export async function updateTasks(db: Db, ctx: ActorContext, input: unknown): Promise<BulkUpdateTasksResponse> {
  assertCanWrite(ctx);
  const { keys, filter, set, dryRun = false } = parseInput(bulkUpdateTasksInput, input);
  const { status, ...changes } = set;

  let targets: string[];
  if (keys) {
    targets = [...new Set(keys.map(normalizeTaskKey))];
  } else if (filter) {
    const { project, ...filters } = filter;
    const matched = await listTasks(db, ctx, project, filters);
    if (matched.length > MAX_BULK_TASKS) {
      throw new DomainError(
        "validation",
        `${matched.length} tasks match; at most ${MAX_BULK_TASKS} can be updated at once. Narrow the filter`,
      );
    }
    targets = matched.map((t) => t.key);
  } else {
    throw new DomainError("validation", "Pass either keys or a filter");
  }

  // Statuses are per project and kind, so a status name is matched in each task's own workflow.
  const projectsByKey = new Map<string, Promise<ProjectDetailDto>>();
  const statusIdIn = async (projectKey: string, kind: TaskKind, value: string) => {
    let project = projectsByKey.get(projectKey);
    if (!project) {
      project = getProject(db, ctx, projectKey);
      projectsByKey.set(projectKey, project);
    }
    const detail = await project;
    // An id of another kind's status is left to applyTaskUpdate, which says why it doesn't fit.
    const match = allStatuses(detail).find((s) => s.id === value) ?? matchStatuses(detail, value, kind)[0];
    if (!match) throw new DomainError("validation", unknownStatusMessage(detail, value, kind));
    return match.id;
  };

  const updateOne = async (tx: Tx, key: string) => {
    const found = await findTask(tx, ctx, key);
    const statusId = status === undefined ? undefined : await statusIdIn(found.projectKey, found.task.kind, status);
    return applyTaskUpdate(tx, ctx, found, { ...changes, statusId });
  };

  const results: BulkTaskResultDto[] = [];
  for (const key of targets) {
    try {
      let outcome: TaskUpdateOutcome | undefined;
      if (dryRun) {
        await db
          .transaction(async (tx) => {
            outcome = await updateOne(tx, key);
            throw rollback;
          })
          .catch((err: unknown) => {
            if (err !== rollback) throw err;
          });
      } else {
        outcome = await db.transaction((tx) => updateOne(tx, key));
      }
      if (!outcome) throw new Error("Bulk update produced no outcome");
      const { task, changed } = outcome;
      results.push({ key: task.key, outcome: changed ? "changed" : "unchanged", task, error: null });
    } catch (err) {
      // Unexpected failures (the database going away) still fail the request.
      if (!(err instanceof DomainError)) throw err;
      results.push({ key, outcome: "error", task: null, error: { code: err.code, message: err.message } });
    }
  }

  const count = (outcome: BulkTaskResultDto["outcome"]) => results.filter((r) => r.outcome === outcome).length;
  return { dryRun, summary: { changed: count("changed"), unchanged: count("unchanged"), failed: count("error") }, results };
}

export async function deleteTask(db: Db, ctx: ActorContext, taskKey: string): Promise<void> {
  assertCanWrite(ctx);
  await db.transaction(async (tx) => {
    const { task, projectKey } = await findTask(tx, ctx, taskKey);
    const now = new Date();
    // Its milestone may be complete without it (ST-96); its sub-tasks leave with it.
    const milestone = task.kind === "task" ? (await effectiveMilestones(tx, [task.id])).get(task.id)?.milestoneId : undefined;
    await tx.update(tasks).set({ deletedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
    await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.deleted" });
    await publish(tx, { type: "task.deleted", orgId: ctx.orgId, projectKey, taskKey: `${projectKey}-${task.number}` });
    // A deleted release no longer holds its tasks (ST-93); shipped ones stay shipped.
    if (task.kind === "release") await releaseTasksOnDelete(tx, ctx, await projectScope(tx, ctx), { id: task.id, key: `${projectKey}-${task.number}` });
    // A deleted milestone no longer holds its tasks (ST-96).
    if (task.kind === "milestone") await milestoneTasksOnDelete(tx, ctx, task.id);

    // Sub-tasks become top-level tasks rather than hanging off a deleted parent (ST-9).
    const children = await tx
      .update(tasks)
      .set({ parentId: null, updatedAt: now })
      .where(and(eq(tasks.parentId, task.id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id, number: tasks.number, projectId: tasks.projectId });
    await settleMilestones(tx, ctx.orgId, [milestone]);
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
