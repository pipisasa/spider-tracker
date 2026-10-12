import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, or } from "drizzle-orm";
import { assertCanWrite, inScope, projectScope, type ActorContext } from "./access";
import type { SavedViewDto } from "./contracts";
import { DomainError } from "./errors";
import { isUuid } from "./ids";
import { createSavedViewInput, updateSavedViewInput, viewFiltersSchema, type ViewFilters } from "./schemas";
import { parseInput } from "./validate";

// Saved views (ST-15): named filter sets per project. A view is personal unless shared; shared
// views are visible to everyone who can see the project. Only the owner of a view (or an
// organization owner/admin) edits or deletes it. Views of projects outside an agent's scope
// are reported as not found.

const { projects, savedViews } = schema;

type Row = typeof savedViews.$inferSelect;

/**
 * Stored filters with an explicit `tagMatch`. Views saved before it existed (ST-73) were applied
 * by the web, which matched any of their tags, so a missing `tagMatch` reads as "any" there.
 */
function readFilters(stored: unknown): ViewFilters {
  // Stored filters are validated on write; fall back to none rather than failing a list.
  const parsed = viewFiltersSchema.safeParse(stored);
  if (!parsed.success) return {};
  return { ...parsed.data, tagMatch: parsed.data.tagMatch ?? (parsed.data.tag?.length ? "any" : "all") };
}

/** New and changed views store `tagMatch` explicitly, "all" when left out. */
const writeFilters = (filters: ViewFilters): ViewFilters => ({ ...filters, tagMatch: filters.tagMatch ?? "all" });

function toDto(row: Row, projectKey: string): SavedViewDto {
  return {
    id: row.id,
    projectKey,
    ownerActorId: row.ownerActorId,
    name: row.name,
    filters: readFilters(row.filters),
    shared: row.shared,
    view: row.view,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findProject(db: Db, ctx: ActorContext, projectKey: string) {
  const [project] = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(and(eq(projects.orgId, ctx.orgId), eq(projects.key, projectKey.toUpperCase())))
    .limit(1);
  if (!project || !inScope(await projectScope(db, ctx), project.id)) {
    throw new DomainError("not_found", `Project ${projectKey} not found`);
  }
  return project;
}

/** The shared views of the project plus the viewer's own, by name. */
export async function listSavedViews(db: Db, ctx: ActorContext, projectKey: string): Promise<SavedViewDto[]> {
  const project = await findProject(db, ctx, projectKey);
  const rows = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.projectId, project.id), or(eq(savedViews.shared, true), eq(savedViews.ownerActorId, ctx.actorId))))
    .orderBy(asc(savedViews.name), asc(savedViews.id));
  return rows.map((row) => toDto(row, project.key));
}

export async function createSavedView(db: Db, ctx: ActorContext, projectKey: string, input: unknown): Promise<SavedViewDto> {
  assertCanWrite(ctx);
  const data = parseInput(createSavedViewInput, input);
  const project = await findProject(db, ctx, projectKey);
  const [row] = await db
    .insert(savedViews)
    .values({
      orgId: ctx.orgId,
      projectId: project.id,
      ownerActorId: ctx.actorId,
      name: data.name,
      filters: writeFilters(data.filters),
      shared: data.shared,
      view: data.view,
    })
    .returning();
  if (!row) throw new DomainError("validation", "Couldn't save the view");
  return toDto(row, project.key);
}

/** A view the actor can see in a project they can see; its owner or an owner/admin may change it. */
async function findEditable(db: Db, ctx: ActorContext, projectKey: string, viewId: string) {
  assertCanWrite(ctx);
  if (!isUuid(viewId)) throw new DomainError("not_found", "View not found");
  const project = await findProject(db, ctx, projectKey);
  const [row] = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, viewId), eq(savedViews.projectId, project.id)))
    .limit(1);
  if (!row || (!row.shared && row.ownerActorId !== ctx.actorId)) throw new DomainError("not_found", "View not found");
  if (row.ownerActorId !== ctx.actorId && ctx.role !== "owner" && ctx.role !== "admin") {
    throw new DomainError("forbidden", "Only the owner of a view can change it");
  }
  return { row, project };
}

export async function updateSavedView(db: Db, ctx: ActorContext, projectKey: string, viewId: string, input: unknown): Promise<SavedViewDto> {
  const data = parseInput(updateSavedViewInput, input);
  const { row, project } = await findEditable(db, ctx, projectKey, viewId);
  const [updated] = await db
    .update(savedViews)
    .set({ ...data, ...(data.filters ? { filters: writeFilters(data.filters) } : {}), updatedAt: new Date() })
    .where(eq(savedViews.id, row.id))
    .returning();
  if (!updated) throw new DomainError("not_found", "View not found");
  return toDto(updated, project.key);
}

export async function deleteSavedView(db: Db, ctx: ActorContext, projectKey: string, viewId: string) {
  const { row } = await findEditable(db, ctx, projectKey, viewId);
  await db.delete(savedViews).where(eq(savedViews.id, row.id));
}
