import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";
import { assertCanManageProjects, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { DeleteStatusResponse, ProjectDetailDto, StatusCategory, TaskKind } from "./contracts";
import { DomainError, isUniqueViolation } from "./errors";
import { publish } from "./events";
import { findProjectForUpdate, withStatuses } from "./projects";
import { createStatusInput, deleteStatusInput, updateStatusInput } from "./schemas";
import { parseInput } from "./validate";
import { z } from "zod";

// Editing a project's workflows (ST-90): the statuses of one task kind, added, renamed, recolored,
// reordered and deleted by owners, admins and their agents. Categories never change, and every
// workflow keeps an open status (not done or canceled) and a done one, so tasks can always start and finish.

const { statuses, tasks } = schema;

type ProjectRow = Awaited<ReturnType<typeof findProjectForUpdate>>;
type StatusRow = typeof statuses.$inferSelect;

const CLOSED: StatusCategory[] = ["done", "canceled"];

const NAME_CONSTRAINT = "statuses_project_kind_lower_name_key";

/** A kind's statuses in board order. */
const workflowRows = (tx: Tx, projectId: string, kind: TaskKind) =>
  tx
    .select()
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.kind, kind)))
    .orderBy(asc(statuses.position), asc(statuses.id));

/** Writes positions 0…n-1 in the given order, touching only rows whose position changes. */
async function renumber(tx: Tx, ordered: StatusRow[]) {
  for (const [position, row] of ordered.entries()) {
    if (row.position !== position) await tx.update(statuses).set({ position }).where(eq(statuses.id, row.id));
  }
}

function assertNameFree(workflow: StatusRow[], name: string, kind: TaskKind, selfId?: string) {
  const taken = workflow.find((s) => s.id !== selfId && s.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new DomainError("conflict", `The ${kind} workflow already has a status "${taken.name}"`);
}

/** Runs a workflow change on the locked project; a name clash that slips past the check is a conflict too. */
async function change<T>(db: Db, ctx: ActorContext, projectKey: string, fn: (tx: Tx, project: ProjectRow) => Promise<T>): Promise<T> {
  await assertCanManageProjects(db, ctx, "change workflows");
  try {
    // Locking the project row serialises workflow changes (and task creation) per project.
    return await db.transaction(async (tx) => fn(tx, await findProjectForUpdate(tx, ctx, projectKey)));
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw new DomainError("conflict", "That workflow already has a status with this name");
    throw err;
  }
}

async function finish(tx: Tx, ctx: ActorContext, project: ProjectRow, action: string, changes: Record<string, unknown>) {
  await recordActivity(tx, ctx, { entityType: "project", entityId: project.id, action, changes });
  await publish(tx, { type: "project.changed", orgId: ctx.orgId, projectKey: project.key });
  return withStatuses(tx, project);
}

/** Adds a status to one kind's workflow, at `position` or at the end. */
export async function createStatus(db: Db, ctx: ActorContext, projectKey: string, input: unknown): Promise<ProjectDetailDto> {
  const data = parseInput(createStatusInput, input);
  return change(db, ctx, projectKey, async (tx, project) => {
    const workflow = await workflowRows(tx, project.id, data.kind);
    assertNameFree(workflow, data.name, data.kind);
    const position = Math.min(data.position ?? workflow.length, workflow.length);
    // Make room: later statuses move one down.
    for (const [i, row] of workflow.entries()) {
      const next = i < position ? i : i + 1;
      if (row.position !== next) await tx.update(statuses).set({ position: next }).where(eq(statuses.id, row.id));
    }
    const [created] = await tx
      .insert(statuses)
      .values({ projectId: project.id, kind: data.kind, name: data.name, category: data.category, color: data.color ?? null, position })
      .returning();
    if (!created) throw new Error("Failed to create status");
    return finish(tx, ctx, project, "project.status_created", {
      statusId: created.id,
      kind: created.kind,
      name: created.name,
      category: created.category,
    });
  });
}

/** Renames, recolors or moves a status within its workflow; its category and kind stay. */
export async function updateStatus(
  db: Db,
  ctx: ActorContext,
  projectKey: string,
  statusId: string,
  input: unknown,
): Promise<ProjectDetailDto> {
  const data = parseInput(updateStatusInput, input);
  return change(db, ctx, projectKey, async (tx, project) => {
    const status = await findProjectStatus(tx, project, statusId);
    const workflow = await workflowRows(tx, project.id, status.kind);
    const changes: Record<string, unknown> = { statusId: status.id, kind: status.kind };
    const patch: Partial<Pick<StatusRow, "name" | "color">> = {};
    if (data.name !== undefined && data.name !== status.name) {
      assertNameFree(workflow, data.name, status.kind, status.id);
      patch.name = data.name;
      changes.name = [status.name, data.name];
    }
    if (data.color !== undefined && data.color !== status.color) {
      patch.color = data.color;
      changes.color = [status.color, data.color];
    }
    if (Object.keys(patch).length > 0) await tx.update(statuses).set(patch).where(eq(statuses.id, status.id));

    if (data.position !== undefined) {
      const others = workflow.filter((s) => s.id !== status.id);
      const position = Math.min(data.position, others.length);
      const from = workflow.findIndex((s) => s.id === status.id);
      if (position !== from) {
        await renumber(tx, [...others.slice(0, position), status, ...others.slice(position)]);
        changes.position = [from, position];
      }
    }

    if (Object.keys(changes).length === 2) return withStatuses(tx, project);
    return finish(tx, ctx, project, "project.status_updated", changes);
  });
}

/**
 * Deletes a status after moving its tasks (deleted ones too) to `moveTo`, another status of the
 * same workflow; they go to the end of its column, with completedAt set or cleared when they
 * close or reopen. Refused when the workflow would be left without an open or a done status.
 */
export async function deleteStatus(
  db: Db,
  ctx: ActorContext,
  projectKey: string,
  statusId: string,
  input: unknown,
): Promise<DeleteStatusResponse> {
  const { moveTo } = parseInput(deleteStatusInput, input);
  return change(db, ctx, projectKey, async (tx, project) => {
    const status = await findProjectStatus(tx, project, statusId);
    if (moveTo === status.id) throw new DomainError("validation", "Move the tasks to another status than the one being deleted");
    const workflow = await workflowRows(tx, project.id, status.kind);
    const target = workflow.find((s) => s.id === moveTo);
    if (!target) throw new DomainError("validation", `Move the tasks to another status of the ${status.kind} workflow`);

    const remaining = workflow.filter((s) => s.id !== status.id);
    if (!remaining.some((s) => !CLOSED.includes(s.category))) {
      throw new DomainError("validation", `The ${status.kind} workflow needs at least one open status (not done or canceled)`);
    }
    if (!remaining.some((s) => s.category === "done")) {
      throw new DomainError("validation", `The ${status.kind} workflow needs at least one done status`);
    }

    const movedTasks = await moveTasks(tx, ctx, project, status, target);
    await tx.delete(statuses).where(eq(statuses.id, status.id));
    await renumber(tx, remaining);
    const detail = await finish(tx, ctx, project, "project.status_deleted", {
      statusId: status.id,
      kind: status.kind,
      name: status.name,
      movedTo: target.id,
      movedTasks,
    });
    return { project: detail, movedTasks };
  });
}

async function findProjectStatus(tx: Tx, project: ProjectRow, statusId: string): Promise<StatusRow> {
  const [status] = z.uuid().safeParse(statusId).success
    ? await tx
        .select()
        .from(statuses)
        .where(and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)))
        .limit(1)
    : [];
  if (!status) throw new DomainError("not_found", `Status not found in ${project.key}`);
  return status;
}

/** Moves every task of `from` to the end of `to`'s column, recording the change on the live ones. */
async function moveTasks(tx: Tx, ctx: ActorContext, project: ProjectRow, from: StatusRow, to: StatusRow): Promise<number> {
  const moving = await tx
    .select({ id: tasks.id, number: tasks.number, deletedAt: tasks.deletedAt, completedAt: tasks.completedAt })
    .from(tasks)
    .where(eq(tasks.statusId, from.id))
    .orderBy(asc(tasks.sortKey), asc(tasks.id));
  if (moving.length === 0) return 0;

  const [last] = await tx
    .select({ sortKey: tasks.sortKey })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), eq(tasks.statusId, to.id), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.sortKey))
    .limit(1);
  const keys = generateNKeysBetween(last?.sortKey ?? null, null, moving.length);

  const wasClosed = CLOSED.includes(from.category);
  const isClosed = CLOSED.includes(to.category);
  const now = new Date();
  for (const [i, task] of moving.entries()) {
    const completedAt = isClosed === wasClosed ? task.completedAt : isClosed ? now : null;
    await tx
      .update(tasks)
      .set({ statusId: to.id, sortKey: keys[i]!, completedAt, updatedAt: now })
      .where(eq(tasks.id, task.id));
    if (task.deletedAt) continue;
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.updated",
      changes: { statusId: [from.id, to.id] },
    });
    await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: project.key, taskKey: `${project.key}-${task.number}` });
  }
  return moving.length;
}
