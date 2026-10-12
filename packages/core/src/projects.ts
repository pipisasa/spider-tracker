import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { assertCanManageProjects, inScope, orgIdOf, projectScope, type ActorContext, type Viewer } from "./access";
import { recordActivity } from "./activity";
import { publish } from "./events";
import type { ProjectDetailDto, ProjectDto, StatusCategory, StatusDto, TaskKind } from "./contracts";
import { DomainError } from "./errors";
import { announceRulesChange, assertRulesDocument } from "./project-rules";
import { TASK_KINDS, createProjectInput, updateProjectInput } from "./schemas";
import { parseInput } from "./validate";

const { agentProjects, projects, statuses } = schema;

type DefaultStatus = { name: string; category: StatusCategory; color: string };

/**
 * Every new project's workflows, one per task kind (ST-90). Existing projects got the release and
 * milestone ones from the migration that added kinds; keep the two in step.
 */
export const DEFAULT_WORKFLOWS: Record<TaskKind, DefaultStatus[]> = {
  task: [
    { name: "Backlog", category: "backlog", color: "#a1a1aa" },
    { name: "Todo", category: "todo", color: "#71717a" },
    { name: "In Progress", category: "in_progress", color: "#eab308" },
    { name: "In Review", category: "in_review", color: "#22c55e" },
    { name: "Done", category: "done", color: "#6366f1" },
    { name: "Canceled", category: "canceled", color: "#a1a1aa" },
  ],
  release: [
    { name: "Planned", category: "todo", color: "#71717a" },
    { name: "On staging", category: "in_progress", color: "#eab308" },
    { name: "Release review", category: "in_review", color: "#22c55e" },
    { name: "Released", category: "done", color: "#6366f1" },
    { name: "Canceled", category: "canceled", color: "#a1a1aa" },
  ],
  milestone: [
    { name: "Planned", category: "todo", color: "#71717a" },
    { name: "Active", category: "in_progress", color: "#eab308" },
    { name: "Ready to close", category: "in_review", color: "#22c55e" },
    { name: "Done", category: "done", color: "#6366f1" },
  ],
};

/** The task workflow of a new project. */
export const DEFAULT_STATUSES = DEFAULT_WORKFLOWS.task;

type ProjectRow = typeof projects.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

export function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    rulesDocumentId: row.rulesDocumentId,
  };
}

export function toStatusDto(row: StatusRow): StatusDto {
  return { id: row.id, kind: row.kind, name: row.name, category: row.category, color: row.color, position: row.position };
}

/** The project with its workflows; `statuses` stays the task workflow, as before kinds (ST-90). */
export function toProjectDetailDto(project: ProjectRow, rows: StatusRow[]): ProjectDetailDto {
  const sorted = [...rows].sort((a, b) => a.position - b.position).map(toStatusDto);
  const workflows: Record<TaskKind, StatusDto[]> = {
    task: sorted.filter((s) => s.kind === "task"),
    release: sorted.filter((s) => s.kind === "release"),
    milestone: sorted.filter((s) => s.kind === "milestone"),
  };
  return { ...toProjectDto(project), statuses: workflows.task, workflows };
}

export async function createProject(db: Db, ctx: ActorContext, input: unknown): Promise<ProjectDetailDto> {
  await assertCanManageProjects(db, ctx, "create projects");
  const { name, key, description } = parseInput(createProjectInput, input);
  const scope = await projectScope(db, ctx);

  const created = await db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ orgId: ctx.orgId, key, name, description: description || null })
      .onConflictDoNothing({ target: [projects.orgId, projects.key] })
      .returning();
    if (!project) throw new DomainError("conflict", `Project key "${key}" is already used`);

    const rows = await tx
      .insert(statuses)
      .values(
        TASK_KINDS.flatMap((kind) =>
          DEFAULT_WORKFLOWS[kind].map((s, position) => ({ ...s, kind, projectId: project.id, position })),
        ),
      )
      .returning();

    // A project-scoped agent gets access to the project it creates.
    if (scope) await tx.insert(agentProjects).values({ agentId: ctx.actorId, projectId: project.id });

    await recordActivity(tx, ctx, {
      entityType: "project",
      entityId: project.id,
      action: "project.created",
      changes: { key, name },
    });

    await publish(tx, { type: "project.changed", orgId: ctx.orgId, projectKey: project.key });
    return toProjectDetailDto(project, rows);
  });
  // The scope is cached per request; keep it in step once the project exists.
  scope?.add(created.id);
  return created;
}

/** Active projects; archived ones too with `includeArchived`. */
export async function listProjects(
  db: Db,
  viewer: Viewer,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProjectDto[]> {
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.orgId, orgIdOf(viewer)),
        includeArchived ? undefined : isNull(projects.archivedAt),
        scope ? inArray(projects.id, [...scope]) : undefined,
      ),
    )
    .orderBy(asc(projects.createdAt));
  return rows.map(toProjectDto);
}

export async function getProject(db: Db, viewer: Viewer, key: string): Promise<ProjectDetailDto> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgIdOf(viewer)), eq(projects.key, key.toUpperCase())))
    .limit(1);
  if (!project || !inScope(await projectScope(db, viewer), project.id)) throw new DomainError("not_found", `Project ${key} not found`);
  const rows = await db.select().from(statuses).where(eq(statuses.projectId, project.id)).orderBy(asc(statuses.position));
  return toProjectDetailDto(project, rows);
}

/** Locks the project row for a change; out-of-scope projects are "not found". */
export async function findProjectForUpdate(tx: Tx, ctx: ActorContext, key: string): Promise<ProjectRow> {
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, ctx.orgId), eq(projects.key, key.toUpperCase())))
    .limit(1)
    .for("update");
  if (!project || !inScope(await projectScope(tx, ctx), project.id)) {
    throw new DomainError("not_found", `Project ${key} not found`);
  }
  return project;
}

export async function withStatuses(tx: Db | Tx, project: ProjectRow): Promise<ProjectDetailDto> {
  const rows = await tx.select().from(statuses).where(eq(statuses.projectId, project.id)).orderBy(asc(statuses.position));
  return toProjectDetailDto(project, rows);
}

/**
 * Renames a project, changes its description or sets its rules document (ST-111); the key stays.
 * Setting rules tells the project's agents (see announceRulesChange).
 */
export async function updateProject(db: Db, ctx: ActorContext, key: string, input: unknown): Promise<ProjectDetailDto> {
  await assertCanManageProjects(db, ctx, "change projects");
  const data = parseInput(updateProjectInput, input);

  return db.transaction(async (tx) => {
    const current = await findProjectForUpdate(tx, ctx, key);
    const next = {
      name: data.name ?? current.name,
      description: data.description === undefined ? current.description : data.description || null,
      rulesDocumentId: data.rulesDocumentId === undefined ? current.rulesDocumentId : data.rulesDocumentId,
    };
    const changes: Record<string, [unknown, unknown]> = {};
    if (next.name !== current.name) changes.name = [current.name, next.name];
    if (next.description !== current.description) changes.description = [current.description, next.description];
    if (next.rulesDocumentId !== current.rulesDocumentId) {
      if (next.rulesDocumentId) await assertRulesDocument(tx, current, next.rulesDocumentId);
      changes.rulesDocumentId = [current.rulesDocumentId, next.rulesDocumentId];
    }
    if (Object.keys(changes).length === 0) return withStatuses(tx, current);

    const [project] = await tx.update(projects).set(next).where(eq(projects.id, current.id)).returning();
    if (!project) throw new Error("Failed to update project");
    await recordActivity(tx, ctx, { entityType: "project", entityId: project.id, action: "project.updated", changes });
    if (changes.rulesDocumentId && project.rulesDocumentId) {
      await announceRulesChange(tx, ctx, project.id, project.rulesDocumentId);
    }
    await publish(tx, { type: "project.changed", orgId: ctx.orgId, projectKey: project.key });
    return withStatuses(tx, project);
  });
}

/** Archives a project (hidden from lists, no new tasks) or restores it; archiving twice changes nothing. */
export async function archiveProject(db: Db, ctx: ActorContext, key: string, archived: boolean): Promise<ProjectDetailDto> {
  await assertCanManageProjects(db, ctx, archived ? "archive projects" : "restore projects");

  return db.transaction(async (tx) => {
    const current = await findProjectForUpdate(tx, ctx, key);
    if ((current.archivedAt !== null) === archived) return withStatuses(tx, current);

    const [project] = await tx
      .update(projects)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(projects.id, current.id))
      .returning();
    if (!project) throw new Error("Failed to archive project");
    await recordActivity(tx, ctx, {
      entityType: "project",
      entityId: project.id,
      action: archived ? "project.archived" : "project.unarchived",
    });
    await publish(tx, { type: "project.changed", orgId: ctx.orgId, projectKey: project.key });
    return withStatuses(tx, project);
  });
}
