import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { assertRole, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { ProjectDetailDto, ProjectDto, StatusCategory, StatusDto } from "./contracts";
import { DomainError } from "./errors";
import { createProjectInput } from "./schemas";
import { parseInput } from "./validate";

const { projects, statuses } = schema;

export const DEFAULT_STATUSES: { name: string; category: StatusCategory; color: string }[] = [
  { name: "Backlog", category: "backlog", color: "#a1a1aa" },
  { name: "Todo", category: "todo", color: "#71717a" },
  { name: "In Progress", category: "in_progress", color: "#eab308" },
  { name: "In Review", category: "in_review", color: "#22c55e" },
  { name: "Done", category: "done", color: "#6366f1" },
  { name: "Canceled", category: "canceled", color: "#a1a1aa" },
];

type ProjectRow = typeof projects.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

export function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toStatusDto(row: StatusRow): StatusDto {
  return { id: row.id, name: row.name, category: row.category, color: row.color, position: row.position };
}

export async function createProject(db: Db, ctx: ActorContext, input: unknown): Promise<ProjectDetailDto> {
  assertRole(ctx, ["owner", "admin"], "create projects");
  const { name, key, description } = parseInput(createProjectInput, input);

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ orgId: ctx.orgId, key, name, description: description || null })
      .onConflictDoNothing({ target: [projects.orgId, projects.key] })
      .returning();
    if (!project) throw new DomainError("conflict", `Project key "${key}" is already used`);

    const created = await tx
      .insert(statuses)
      .values(DEFAULT_STATUSES.map((s, position) => ({ ...s, projectId: project.id, position })))
      .returning();

    await recordActivity(tx, ctx, {
      entityType: "project",
      entityId: project.id,
      action: "project.created",
      changes: { key, name },
    });

    return { ...toProjectDto(project), statuses: created.sort((a, b) => a.position - b.position).map(toStatusDto) };
  });
}

export async function listProjects(db: Db, orgId: string): Promise<ProjectDto[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), isNull(projects.archivedAt)))
    .orderBy(asc(projects.createdAt));
  return rows.map(toProjectDto);
}

export async function getProject(db: Db, orgId: string, key: string): Promise<ProjectDetailDto> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.key, key.toUpperCase())))
    .limit(1);
  if (!project) throw new DomainError("not_found", `Project ${key} not found`);
  const rows = await db.select().from(statuses).where(eq(statuses.projectId, project.id)).orderBy(asc(statuses.position));
  return { ...toProjectDto(project), statuses: rows.map(toStatusDto) };
}
