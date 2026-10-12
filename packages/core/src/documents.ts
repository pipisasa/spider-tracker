import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  assertCanWrite,
  inScope,
  orgIdOf,
  projectScope,
  type ActorContext,
  type Viewer,
} from "./access";
import { recordActivity } from "./activity";
import type {
  DocumentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
} from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import {
  createDocumentInput,
  documentListQuery,
  moveDocumentInput,
  updateDocumentInput,
} from "./schemas";
import { findTask } from "./tasks";
import { parseInput } from "./validate";

// Documents (ST-21): Markdown or HTML at organization, project or task level, with a
// version row for every save. Edits name the version they started from (`baseVersion`),
// so two people saving over each other get a conflict instead of a silent overwrite.

const { documents, documentVersions, projects, tasks } = schema;

type DocumentRow = typeof documents.$inferSelect;
type Scope = { projectKey: string | null; taskKey: string | null };

const isUuid = (value: string) => z.uuid().safeParse(value).success;

function toSummary(row: DocumentRow, scope: Scope): DocumentSummaryDto {
  return {
    id: row.id,
    title: row.title,
    format: row.format,
    projectKey: scope.projectKey,
    taskKey: scope.taskKey,
    version: row.version,
    authorId: row.authorId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const toDocumentDto = (row: DocumentRow, scope: Scope): DocumentDto => ({
  ...toSummary(row, scope),
  content: row.content,
});

async function findProject(db: Db | Tx, viewer: Viewer, key: string) {
  const [project] = await db
    .select({
      id: projects.id,
      key: projects.key,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(
      and(
        eq(projects.orgId, orgIdOf(viewer)),
        eq(projects.key, key.trim().toUpperCase()),
      ),
    )
    .limit(1);
  if (!project || !inScope(await projectScope(db, viewer), project.id))
    throw new DomainError("not_found", `Project ${key} not found`);
  return project;
}

function assertActive(project: { key: string; archivedAt: Date | null }) {
  if (project.archivedAt)
    throw new DomainError("validation", `Project ${project.key} is archived`);
}

async function assertNotArchived(db: Db | Tx, viewer: Viewer, key: string) {
  assertActive(await findProject(db, viewer, key));
}

/** Documents with their scope keys; those on deleted tasks are hidden. */
function selectDocuments(db: Db | Tx, where: SQL | undefined) {
  return db
    .select({
      document: documents,
      projectKey: projects.key,
      taskNumber: tasks.number,
    })
    .from(documents)
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .leftJoin(tasks, eq(documents.taskId, tasks.id))
    .where(
      and(
        isNull(documents.deletedAt),
        or(isNull(documents.taskId), isNull(tasks.deletedAt)),
        where,
      ),
    );
}

function scopeOf(row: {
  projectKey: string | null;
  taskNumber: number | null;
}): Scope {
  return {
    projectKey: row.projectKey,
    taskKey:
      row.projectKey && row.taskNumber !== null
        ? `${row.projectKey}-${row.taskNumber}`
        : null,
  };
}

/** `lock` holds the document row until the transaction ends, so concurrent saves queue up. */
async function findDocument(
  db: Db | Tx,
  viewer: Viewer,
  id: string,
  lock = false,
) {
  if (!isUuid(id)) throw new DomainError("not_found", "Document not found");
  const query = selectDocuments(
    db,
    and(eq(documents.orgId, orgIdOf(viewer)), eq(documents.id, id)),
  ).limit(1);
  const [row] = lock
    ? await query.for("update", { of: documents })
    : await query;
  // Organization-level documents are visible to every member, scoped agents included.
  const visible =
    row &&
    (row.document.projectId === null ||
      inScope(await projectScope(db, viewer), row.document.projectId));
  if (!row || !visible)
    throw new DomainError("not_found", "Document not found");
  return { document: row.document, scope: scopeOf(row) };
}

async function announce(
  tx: Tx,
  ctx: ActorContext,
  type: "document.changed" | "document.deleted",
  id: string,
  scope: Scope,
) {
  await publish(tx, { type, orgId: ctx.orgId, documentId: id, ...scope });
}

export async function createDocument(
  db: Db,
  ctx: ActorContext,
  input: unknown,
): Promise<DocumentDto> {
  assertCanWrite(ctx);
  const data = parseInput(createDocumentInput, input);

  return db.transaction(async (tx) => {
    let projectId: string | null = null;
    let taskId: string | null = null;
    let scope: Scope = { projectKey: null, taskKey: null };
    if (data.task) {
      const { task, projectKey } = await findTask(tx, ctx, data.task);
      if (data.project && data.project.trim().toUpperCase() !== projectKey) {
        throw new DomainError(
          "validation",
          `Task ${data.task} isn't in project ${data.project}`,
        );
      }
      await assertNotArchived(tx, ctx, projectKey);
      projectId = task.projectId;
      taskId = task.id;
      scope = { projectKey, taskKey: `${projectKey}-${task.number}` };
    } else if (data.project) {
      const project = await findProject(tx, ctx, data.project);
      assertActive(project);
      projectId = project.id;
      scope = { projectKey: project.key, taskKey: null };
    }

    const [document] = await tx
      .insert(documents)
      .values({
        orgId: ctx.orgId,
        projectId,
        taskId,
        title: data.title,
        format: data.format,
        content: data.content,
        createdBy: ctx.actorId,
        authorId: ctx.actorId,
      })
      .returning();
    if (!document) throw new Error("Failed to create document");

    await tx.insert(documentVersions).values({
      documentId: document.id,
      version: document.version,
      title: document.title,
      format: document.format,
      content: document.content,
      authorId: ctx.actorId,
    });
    await recordActivity(tx, ctx, {
      entityType: "document",
      entityId: document.id,
      action: "document.created",
      changes: { title: document.title, format: document.format, ...scope },
    });
    await announce(tx, ctx, "document.changed", document.id, scope);
    return toDocumentDto(document, scope);
  });
}

/** Documents without their content, most recently updated first. */
export async function listDocuments(
  db: Db,
  viewer: Viewer,
  query: unknown = {},
): Promise<DocumentSummaryDto[]> {
  const filter = parseInput(documentListQuery, query);
  const where: (SQL | undefined)[] = [eq(documents.orgId, orgIdOf(viewer))];
  if (filter.task) {
    const { task } = await findTask(db, viewer, filter.task);
    where.push(eq(documents.taskId, task.id));
  } else if (filter.project) {
    const project = await findProject(db, viewer, filter.project);
    where.push(eq(documents.projectId, project.id));
  }
  const scope = await projectScope(db, viewer);
  if (scope) {
    where.push(
      or(isNull(documents.projectId), inArray(documents.projectId, [...scope])),
    );
  }
  const rows = await selectDocuments(db, and(...where)).orderBy(
    desc(documents.updatedAt),
    desc(documents.id),
  );
  return rows.map((r) => toSummary(r.document, scopeOf(r)));
}

export async function getDocument(
  db: Db,
  viewer: Viewer,
  id: string,
): Promise<DocumentDto> {
  const { document, scope } = await findDocument(db, viewer, id);
  return toDocumentDto(document, scope);
}

/**
 * Saves a new version. Fails with "conflict" when the document was saved since
 * `baseVersion`; returns the document unchanged when nothing differs.
 */
export async function updateDocument(
  db: Db,
  ctx: ActorContext,
  id: string,
  input: unknown,
): Promise<DocumentDto> {
  assertCanWrite(ctx);
  const data = parseInput(updateDocumentInput, input);

  return db.transaction(async (tx) => {
    const { document: current, scope } = await findDocument(tx, ctx, id, true);
    const version = current.version;
    if (data.baseVersion !== version) {
      throw new DomainError(
        "conflict",
        `The document was changed since version ${data.baseVersion} (it is now at version ${version}). Reload it and apply your edit again`,
      );
    }

    const next = {
      title: data.title ?? current.title,
      format: data.format ?? current.format,
      content: data.content ?? current.content,
    };
    const changed = (["title", "format", "content"] as const).filter(
      (field) => next[field] !== current[field],
    );
    if (changed.length === 0) return toDocumentDto(current, scope);

    const [updated] = await tx
      .update(documents)
      .set({
        ...next,
        version: version + 1,
        authorId: ctx.actorId,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, current.id))
      .returning();
    if (!updated) throw new Error("Failed to update document");

    await tx.insert(documentVersions).values({
      documentId: updated.id,
      version: updated.version,
      title: updated.title,
      format: updated.format,
      content: updated.content,
      authorId: ctx.actorId,
    });
    await recordActivity(tx, ctx, {
      entityType: "document",
      entityId: updated.id,
      action: "document.updated",
      changes: {
        version: [version, updated.version],
        fields: changed,
        ...(changed.includes("title")
          ? { title: [current.title, updated.title] }
          : {}),
        ...(changed.includes("format")
          ? { format: [current.format, updated.format] }
          : {}),
      },
    });
    await announce(tx, ctx, "document.changed", updated.id, scope);
    return toDocumentDto(updated, scope);
  });
}

/**
 * Moves a document to another project, or to the whole organization (`project: null`).
 * The id, versions and content stay; only the scope changes, and no version is added.
 * A task document leaves its task (it becomes a plain document of the target); moving
 * it to its own project just detaches it. Like every write, both the document's current
 * project and the target must be in the actor's scope.
 */
export async function moveDocument(
  db: Db,
  ctx: ActorContext,
  id: string,
  input: unknown,
): Promise<DocumentDto> {
  assertCanWrite(ctx);
  const data = parseInput(moveDocumentInput, input);

  return db.transaction(async (tx) => {
    const { document: current, scope: from } = await findDocument(
      tx,
      ctx,
      id,
      true,
    );
    const target = data.project
      ? await findProject(tx, ctx, data.project)
      : null;
    // Moving out of an archived project is fine; moving into one is not.
    if (target && target.id !== current.projectId) assertActive(target);
    const projectId = target?.id ?? null;
    if (projectId === current.projectId && current.taskId === null)
      return toDocumentDto(current, from);

    const [updated] = await tx
      .update(documents)
      .set({ projectId, taskId: null })
      .where(eq(documents.id, current.id))
      .returning();
    if (!updated) throw new Error("Failed to move document");

    const to: Scope = { projectKey: target?.key ?? null, taskKey: null };
    await recordActivity(tx, ctx, {
      entityType: "document",
      entityId: updated.id,
      action: "document.moved",
      changes: {
        title: updated.title,
        project: [from.projectKey, to.projectKey],
        ...(from.taskKey ? { task: [from.taskKey, null] } : {}),
      },
    });
    // Viewers of the old scope need to refresh as well as those of the new one.
    await announce(tx, ctx, "document.changed", updated.id, from);
    await announce(tx, ctx, "document.changed", updated.id, to);
    return toDocumentDto(updated, to);
  });
}

export async function deleteDocument(db: Db, ctx: ActorContext, id: string) {
  assertCanWrite(ctx);
  await db.transaction(async (tx) => {
    const { document, scope } = await findDocument(tx, ctx, id);
    await tx
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(eq(documents.id, document.id));
    await recordActivity(tx, ctx, {
      entityType: "document",
      entityId: document.id,
      action: "document.deleted",
      changes: { title: document.title },
    });
    await announce(tx, ctx, "document.deleted", document.id, scope);
  });
}

/** Every saved version, newest first, without content. */
export async function listDocumentVersions(
  db: Db,
  viewer: Viewer,
  id: string,
): Promise<DocumentVersionSummaryDto[]> {
  const { document } = await findDocument(db, viewer, id);
  const rows = await db
    .select({
      version: documentVersions.version,
      title: documentVersions.title,
      format: documentVersions.format,
      authorId: documentVersions.authorId,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, document.id))
    .orderBy(desc(documentVersions.version));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function getDocumentVersion(
  db: Db,
  viewer: Viewer,
  id: string,
  version: number | string,
): Promise<DocumentVersionDto> {
  const { document } = await findDocument(db, viewer, id);
  const number = Number(version);
  if (!Number.isInteger(number) || number < 1)
    throw new DomainError("not_found", `Version ${version} not found`);
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, document.id),
        eq(documentVersions.version, number),
      ),
    )
    .limit(1);
  if (!row) throw new DomainError("not_found", `Version ${version} not found`);
  return {
    documentId: row.documentId,
    version: row.version,
    title: row.title,
    format: row.format,
    content: row.content,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}
