import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  assertCanManageProjects,
  assertCanWrite,
  inScope,
  orgIdOf,
  projectScope,
  type ActorContext,
  type ProjectScope,
  type Viewer,
} from "./access";
import { recordActivity } from "./activity";
import type {
  DocumentDiffDto,
  DocumentDto,
  DocumentGraphDto,
  DocumentGraphTaskDto,
  DocumentLinkDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  RelinkedDocumentsDto,
  UpdatedDocumentDto,
} from "./contracts";
import { diffHunks, diffLines } from "./diff";
import { applyDocumentEdits } from "./document-edits";
import { DomainError, isLockConflict } from "./errors";
import { publish } from "./events";
import { isUuid } from "./ids";
import {
  documentIdLink,
  isLinkableTitle,
  normalizeTitle,
  outgoingLinksIn,
  resolveDocumentLink,
  resolveTitle,
  retargetTitleLinks,
  type LinkCandidate,
} from "./links";
import { announceRulesChange, rulesProjectOf } from "./project-rules";
import {
  createDocumentInput,
  documentDiffQuery,
  documentListQuery,
  editDocumentInput,
  MAX_DOCUMENT_BYTES,
  moveDocumentInput,
  updateDocumentInput,
} from "./schemas";
import { findTask } from "./tasks";
import { parseInput } from "./validate";

// Documents (ST-21): Markdown or HTML at organization, project or task level, with a
// version row for every save. Edits name the version they started from (`baseVersion`),
// so two people saving over each other get a conflict instead of a silent overwrite.

const {
  documentLinks,
  documents,
  documentVersions,
  projects,
  statuses,
  tasks,
} = schema;

type DocumentRow = typeof documents.$inferSelect;
type Scope = { projectKey: string | null; taskKey: string | null };

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

/** Organization-wide documents, and those of the projects in `scope`. */
function visibleIn(scope: ProjectScope): SQL | undefined {
  return scope
    ? or(isNull(documents.projectId), inArray(documents.projectId, [...scope]))
    : undefined;
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

/**
 * A document the viewer can see, with its scope keys; "not found" otherwise. `lock` holds the
 * document row until the transaction ends, so concurrent saves queue up.
 */
export async function findDocument(
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

/**
 * A project's rules document (ST-111) is changed, moved or deleted only by those who manage
 * projects: owners, admins and their agents. Returns the project it is the rules of.
 */
async function guardRules(tx: Tx, ctx: ActorContext, documentId: string) {
  const project = await rulesProjectOf(tx, documentId);
  if (project)
    await assertCanManageProjects(
      tx,
      ctx,
      `change the rules of ${project.key}`,
    );
  return project;
}

/** A rules document left its project: the project has no rules until new ones are set. */
async function dropRules(
  tx: Tx,
  ctx: ActorContext,
  documentId: string,
  project: { id: string; key: string } | undefined,
) {
  if (!project) return;
  await tx
    .update(projects)
    .set({ rulesDocumentId: null })
    .where(eq(projects.id, project.id));
  await recordActivity(tx, ctx, {
    entityType: "project",
    entityId: project.id,
    action: "project.updated",
    changes: { rulesDocumentId: [documentId, null] },
  });
  await publish(tx, {
    type: "project.changed",
    orgId: ctx.orgId,
    projectKey: project.key,
  });
}

/** Saves through `save`; when it made a new version of a rules document, tells the project's agents. */
async function saveGuarded(
  tx: Tx,
  ctx: ActorContext,
  current: DocumentRow,
  save: () => Promise<DocumentDto>,
): Promise<DocumentDto> {
  const rulesOf = await guardRules(tx, ctx, current.id);
  const saved = await save();
  if (rulesOf && saved.version !== current.version)
    await announceRulesChange(tx, ctx, rulesOf.id, current.id);
  return saved;
}

/**
 * Rewrites what a document links to from its current content (ST-100). Links by id are stored as
 * `doc:<id>` document targets (ST-115), next to titles.
 */
async function writeLinks(tx: Tx, documentId: string, content: string) {
  await tx
    .delete(documentLinks)
    .where(eq(documentLinks.documentId, documentId));
  const links = outgoingLinksIn(content);
  const rows = [
    ...links.documents.map((target) => ({
      documentId,
      kind: "document" as const,
      target,
    })),
    ...links.documentIds.map((id) => ({
      documentId,
      kind: "document" as const,
      target: documentIdLink(id),
    })),
    ...links.tasks.map((target) => ({
      documentId,
      kind: "task" as const,
      target,
    })),
  ];
  if (rows.length) await tx.insert(documentLinks).values(rows);
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
    await writeLinks(tx, document.id, document.content);

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
  where.push(visibleIn(await projectScope(db, viewer)));
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
 * `baseVersion`; returns the document unchanged when nothing differs. A rename rewrites the
 * `[[Old title]]` links leading here (see relinkRenamed) and says what it did in `relinked`.
 */
export async function updateDocument(
  db: Db,
  ctx: ActorContext,
  id: string,
  input: unknown,
): Promise<UpdatedDocumentDto> {
  assertCanWrite(ctx);
  const data = parseInput(updateDocumentInput, input);

  try {
    return await db.transaction(async (tx) => {
      if (data.title !== undefined)
        await lockRenameRows(tx, ctx, id, data.title);
      const { document: current, scope } = await findDocument(
        tx,
        ctx,
        id,
        true,
      );
      assertBaseVersion(current, data.baseVersion);
      const saved = await saveGuarded(tx, ctx, current, () =>
        saveVersion(tx, ctx, current, scope, {
          title: data.title ?? current.title,
          format: data.format ?? current.format,
          content: data.content ?? current.content,
        }),
      );
      if (saved.title === current.title) return saved;
      return {
        ...saved,
        relinked: await relinkRenamed(tx, ctx, current, saved.title),
      };
    });
  } catch (err) {
    // What the ordered lock below can't foresee (a link written after it read them).
    if (isLockConflict(err)) {
      throw new DomainError(
        "conflict",
        "The document was changed by another save at the same time. Reload it and try again",
      );
    }
    throw err;
  }
}

/** The documents other than `renamedId` with a `[[title]]` link (any project), by id. */
function linkingSources(tx: Tx, renamedId: string, title: string) {
  return tx
    .selectDistinct({ id: documentLinks.documentId })
    .from(documentLinks)
    .where(
      and(
        eq(documentLinks.kind, "document"),
        sql`lower(${documentLinks.target}) = ${normalizeTitle(title)}`,
        sql`${documentLinks.documentId} <> ${renamedId}`,
      ),
    )
    .orderBy(asc(documentLinks.documentId));
}

/**
 * Before a save that may rename document `id`, locks it and the documents linking to its current
 * title in one statement, in id order. Two renames whose linking documents overlap (A links B, B
 * links A) then queue up instead of deadlocking, as they would locking their own row first.
 */
async function lockRenameRows(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  newTitle: string,
) {
  if (!isUuid(id)) return;
  const [row] = await tx
    .select({ title: documents.title })
    .from(documents)
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)))
    .limit(1);
  if (!row || normalizeTitle(row.title) === normalizeTitle(newTitle)) return;
  const sources = await linkingSources(tx, id, row.title);
  await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.orgId, ctx.orgId),
        inArray(documents.id, [id, ...sources.map((s) => s.id)]),
      ),
    )
    .orderBy(asc(documents.id))
    .for("update");
}

/**
 * After `renamed` got `newTitle` (ST-101), rewrites the `[[Old title]]` links that opened it, as
 * Obsidian does: each linking document gets one new version, saved by the renamer like any of
 * their saves. It runs with the renamer's rights, never past them: documents they can't see stay
 * as they are (their links go unresolved, as before this existed), and a project's rules document
 * is skipped unless they may change rules. A link keeps its `#heading` and `|label`; it becomes
 * `[[doc:<id>]]` instead when the new title can't be linked to or another document has it too.
 * `[[doc:<id>]]` links need nothing, and a document's links to itself are left alone.
 */
async function relinkRenamed(
  tx: Tx,
  ctx: ActorContext,
  renamed: DocumentRow,
  newTitle: string,
): Promise<RelinkedDocumentsDto> {
  const result: RelinkedDocumentsDto = { rewritten: [], skipped: [] };
  const oldTitle = renamed.title;
  if (normalizeTitle(oldTitle) === normalizeTitle(newTitle)) return result;

  const sources = await linkingSources(tx, renamed.id, oldTitle);
  if (!sources.length) return result;

  // Which document a title opens depends on every live document of the organization, not on
  // what the renamer sees.
  const rows = await selectDocuments(tx, eq(documents.orgId, ctx.orgId));
  const after: (LinkCandidate & { projectId: string | null })[] = rows.map(
    (r) => ({
      id: r.document.id,
      title: r.document.title,
      projectId: r.document.projectId,
      projectKey: r.projectKey,
      updatedAt: r.document.updatedAt.toISOString(),
    }),
  );
  // As it was before the save: the renamed document's old title and its old `updatedAt`, which
  // decides between documents of the same title and rank.
  const before = after.map((d) =>
    d.id === renamed.id
      ? { ...d, title: oldTitle, updatedAt: renamed.updatedAt.toISOString() }
      : d,
  );
  // A title another document has too could open that one, now or after its next save.
  const titleIsFree =
    isLinkableTitle(newTitle) &&
    !after.some(
      (d) =>
        d.id !== renamed.id &&
        normalizeTitle(d.title) === normalizeTitle(newTitle),
    );
  const byId = new Map(after.map((d) => [d.id, d]));
  const scope = await projectScope(tx, ctx);
  let canChangeRules: boolean | undefined;

  for (const { id } of sources) {
    const source = byId.get(id);
    // What findDocument lets the renamer see: organization-wide documents, and their projects'.
    if (
      !source ||
      (source.projectId !== null && !inScope(scope, source.projectId))
    )
      continue;
    if (resolveTitle(before, oldTitle, source.projectKey)?.id !== renamed.id)
      continue;

    let locked: Awaited<ReturnType<typeof findDocument>>;
    try {
      locked = await findDocument(tx, ctx, id, true);
    } catch (err) {
      // Deleted or moved out of sight since the read above: nothing to rewrite.
      if (err instanceof DomainError && err.code === "not_found") continue;
      throw err;
    }
    const { document: current, scope: at } = locked;
    const rulesOf = await rulesProjectOf(tx, id);
    if (rulesOf) {
      canChangeRules ??= await assertCanManageProjects(
        tx,
        ctx,
        "change rules",
      ).then(
        () => true,
        () => false,
      );
      if (!canChangeRules) {
        result.skipped.push({ id, title: current.title, reason: "rules" });
        continue;
      }
    }
    const byTitle =
      titleIsFree &&
      // Raw `<`, `&` or `>` would turn into markup in an HTML document.
      !(current.format === "html" && /[<&>]/.test(newTitle));
    const target = byTitle
      ? newTitle.trim().replace(/\s+/g, " ")
      : documentIdLink(renamed.id);
    const content = retargetTitleLinks(current.content, oldTitle, target);
    if (content === current.content) continue;
    if (new TextEncoder().encode(content).length > MAX_DOCUMENT_BYTES) {
      result.skipped.push({ id, title: current.title, reason: "too_large" });
      continue;
    }
    await saveVersion(
      tx,
      ctx,
      current,
      at,
      { title: current.title, format: current.format, content },
      { relinked: { documentId: renamed.id, title: [oldTitle, newTitle] } },
    );
    if (rulesOf) await announceRulesChange(tx, ctx, rulesOf.id, id);
    result.rewritten.push({ id, title: current.title });
  }
  return result;
}

/**
 * Applies partial edits (ST-116: replace a fragment, append, replace a Markdown section) and
 * saves the result as one new version. With `baseVersion` it fails on a newer save, like
 * updateDocument; without it the edits apply to the current version under the row lock, so a
 * concurrent save can't be overwritten: a fragment that is no longer there is a "conflict".
 */
export async function editDocument(
  db: Db,
  ctx: ActorContext,
  id: string,
  input: unknown,
): Promise<DocumentDto> {
  assertCanWrite(ctx);
  const data = parseInput(editDocumentInput, input);

  return db.transaction(async (tx) => {
    const { document: current, scope } = await findDocument(tx, ctx, id, true);
    if (data.baseVersion !== undefined)
      assertBaseVersion(current, data.baseVersion);
    const content = applyDocumentEdits(
      current.content,
      current.format,
      data.edits,
    );
    if (new TextEncoder().encode(content).length > MAX_DOCUMENT_BYTES) {
      throw new DomainError(
        "validation",
        "The edited document would be over 1 MB",
      );
    }
    return saveGuarded(tx, ctx, current, () =>
      saveVersion(
        tx,
        ctx,
        current,
        scope,
        { title: current.title, format: current.format, content },
        {
          edits: data.edits.map((e) =>
            "old" in e ? "replace" : "append" in e ? "append" : "section",
          ),
        },
      ),
    );
  });
}

function assertBaseVersion(current: DocumentRow, baseVersion: number) {
  if (baseVersion !== current.version) {
    throw new DomainError(
      "conflict",
      `The document was changed since version ${baseVersion} (it is now at version ${current.version}). Reload it and apply your edit again`,
    );
  }
}

/** Saves `next` as a new version of the locked `current` row; returns it unchanged when nothing differs. */
async function saveVersion(
  tx: Tx,
  ctx: ActorContext,
  current: DocumentRow,
  scope: Scope,
  next: Pick<DocumentRow, "title" | "format" | "content">,
  details: Record<string, unknown> = {},
): Promise<DocumentDto> {
  const version = current.version;
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
  if (changed.includes("content"))
    await writeLinks(tx, updated.id, updated.content);

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
      ...details,
    },
  });
  await announce(tx, ctx, "document.changed", updated.id, scope);
  return toDocumentDto(updated, scope);
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
    // A rules document (never a task's) only gets here when it leaves its project.
    await dropRules(tx, ctx, current.id, await guardRules(tx, ctx, current.id));

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
    await dropRules(
      tx,
      ctx,
      document.id,
      await guardRules(tx, ctx, document.id),
    );
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
  const row = await findVersion(db, document.id, version);
  return {
    ...toVersionSummary(row),
    documentId: row.documentId,
    content: row.content,
  };
}

type VersionRow = typeof documentVersions.$inferSelect;

async function findVersion(
  db: Db,
  documentId: string,
  version: number | string,
): Promise<VersionRow> {
  const number = Number(version);
  if (!Number.isInteger(number) || number < 1)
    throw new DomainError("not_found", `Version ${version} not found`);
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.version, number),
      ),
    )
    .limit(1);
  if (!row) throw new DomainError("not_found", `Version ${version} not found`);
  return row;
}

const toVersionSummary = (row: VersionRow): DocumentVersionSummaryDto => ({
  version: row.version,
  title: row.title,
  format: row.format,
  authorId: row.authorId,
  createdAt: row.createdAt.toISOString(),
});

/**
 * What changed between two saved versions, line by line (ST-117): `{ from, to? }`, where a
 * missing `to` means the current version. Readable by whoever can read the document.
 */
export async function diffDocumentVersions(
  db: Db,
  viewer: Viewer,
  id: string,
  query: unknown,
): Promise<DocumentDiffDto> {
  const { document } = await findDocument(db, viewer, id);
  const { from, to = document.version } = parseInput(documentDiffQuery, query);
  const [a, b] = await Promise.all([
    findVersion(db, document.id, from),
    findVersion(db, document.id, to),
  ]);
  const lines = diffLines(a.content, b.content);
  return {
    documentId: document.id,
    from: toVersionSummary(a),
    to: toVersionSummary(b),
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
    hunks: diffHunks(lines),
  };
}

/**
 * The documents linking to this one with `[[its title]]` or `[[doc:<its id>]]`, most recently
 * updated first. A title link counts when it resolves here: with several documents of the same
 * title, a link opens one of them (see resolveTitle), and only that one lists it.
 */
export async function listBacklinks(
  db: Db,
  viewer: Viewer,
  id: string,
): Promise<DocumentSummaryDto[]> {
  const { document } = await findDocument(db, viewer, id);
  const visible = await listDocuments(db, viewer);
  const byId = documentIdLink(document.id);
  const rows = await db
    .select({
      documentId: documentLinks.documentId,
      target: documentLinks.target,
    })
    .from(documentLinks)
    .where(
      and(
        eq(documentLinks.kind, "document"),
        // Served by the (kind, lower(target)) index; `doc:<id>` targets are stored lower-case.
        sql`lower(${documentLinks.target}) in (${normalizeTitle(document.title)}, ${byId})`,
      ),
    );
  const byIdLinks = new Set(
    rows.filter((r) => r.target === byId).map((r) => r.documentId),
  );
  const byTitleLinks = new Set(
    rows.filter((r) => r.target !== byId).map((r) => r.documentId),
  );
  return visible.filter(
    (source) =>
      source.id !== document.id &&
      (byIdLinks.has(source.id) ||
        (byTitleLinks.has(source.id) &&
          resolveTitle(visible, document.title, source.projectKey)?.id ===
            document.id)),
  );
}

/**
 * The documents mentioning a task (ST-101): `[[ST-12]]` or a plain ST-12 in their content, most
 * recently updated first. The task's own documents are left out.
 */
export async function listTaskBacklinks(
  db: Db,
  viewer: Viewer,
  taskKey: string,
): Promise<DocumentSummaryDto[]> {
  const { task, projectKey } = await findTask(db, viewer, taskKey);
  const mentioning = db
    .select({ id: documentLinks.documentId })
    .from(documentLinks)
    // Served by the (kind, lower(target)) index; task targets are stored as "ST-12".
    .where(
      and(
        eq(documentLinks.kind, "task"),
        sql`lower(${documentLinks.target}) = ${`${projectKey}-${task.number}`.toLowerCase()}`,
      ),
    );
  const rows = await selectDocuments(
    db,
    and(
      eq(documents.orgId, orgIdOf(viewer)),
      inArray(documents.id, mentioning),
      or(isNull(documents.taskId), ne(documents.taskId, task.id)),
      visibleIn(await projectScope(db, viewer)),
    ),
  ).orderBy(desc(documents.updatedAt), desc(documents.id));
  return rows.map((r) => toSummary(r.document, scopeOf(r)));
}

/**
 * The organization's documents as a graph (ST-100): what the viewer can see, the tasks and
 * projects those documents sit in or link to, and every link. Links to tasks that don't exist
 * or are out of scope are dropped; `[[titles]]` no document has stay as unresolved targets.
 */
export async function getDocumentGraph(
  db: Db,
  viewer: Viewer,
): Promise<DocumentGraphDto> {
  const docs = await listDocuments(db, viewer);
  const byId = new Map(docs.map((d) => [d.id, d]));
  // The visible documents' links, through a join rather than a list of their ids, so a large
  // organization stays under Postgres' parameter limit; `byId` drops those on deleted tasks.
  const rows = docs.length
    ? await db
        .select({
          documentId: documentLinks.documentId,
          kind: documentLinks.kind,
          target: documentLinks.target,
        })
        .from(documentLinks)
        .innerJoin(documents, eq(documentLinks.documentId, documents.id))
        .where(
          and(
            eq(documents.orgId, orgIdOf(viewer)),
            isNull(documents.deletedAt),
            visibleIn(await projectScope(db, viewer)),
          ),
        )
        .orderBy(
          asc(documentLinks.documentId),
          asc(documentLinks.kind),
          asc(documentLinks.target),
        )
    : [];

  const taskKeys = new Set<string>();
  for (const d of docs) if (d.taskKey) taskKeys.add(d.taskKey);
  for (const r of rows) if (r.kind === "task") taskKeys.add(r.target);
  const graphTasks = await findGraphTasks(db, viewer, [...taskKeys]);
  const knownTasks = new Set(graphTasks.map((t) => t.key));

  const links: DocumentLinkDto[] = [];
  // Rows differing only in case ("Plan", "plan") resolve alike; each edge is listed once.
  const seen = new Set<string>();
  const add = (link: DocumentLinkDto) => {
    const to = link.to;
    const key = `${link.from}|${to.type === "document" ? to.id : to.type === "task" ? to.key : normalizeTitle(to.title)}|${to.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  for (const r of rows) {
    const source = byId.get(r.documentId);
    if (!source) continue;
    if (r.kind === "task") {
      if (knownTasks.has(r.target) && r.target !== source.taskKey)
        add({ from: source.id, to: { type: "task", key: r.target } });
      continue;
    }
    const target = resolveDocumentLink(docs, r.target, source.projectKey);
    if (target?.id === source.id) continue;
    add({
      from: source.id,
      to: target
        ? { type: "document", id: target.id }
        : { type: "unresolved", title: r.target },
    });
  }

  const projectKeys = new Set<string>();
  for (const d of docs) if (d.projectKey) projectKeys.add(d.projectKey);
  for (const t of graphTasks) projectKeys.add(t.projectKey);
  const scope = await projectScope(db, viewer);
  const projectRows = projectKeys.size
    ? await db
        .select({ id: projects.id, key: projects.key, name: projects.name })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, orgIdOf(viewer)),
            inArray(projects.key, [...projectKeys]),
          ),
        )
        .orderBy(asc(projects.createdAt))
    : [];
  return {
    documents: docs,
    tasks: graphTasks,
    projects: projectRows
      .filter((p) => inScope(scope, p.id))
      .map(({ key, name }) => ({ key, name })),
    links,
  };
}

/** The tasks with these keys that exist, aren't deleted and are in the viewer's scope. */
async function findGraphTasks(
  db: Db,
  viewer: Viewer,
  keys: string[],
): Promise<DocumentGraphTaskDto[]> {
  if (!keys.length) return [];
  const taskKey = sql<string>`${projects.key} || '-' || ${tasks.number}`;
  const rows = await db
    .select({
      projectId: projects.id,
      projectKey: projects.key,
      number: tasks.number,
      title: tasks.title,
      statusCategory: statuses.category,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(statuses, eq(tasks.statusId, statuses.id))
    .where(
      and(
        eq(tasks.orgId, orgIdOf(viewer)),
        isNull(tasks.deletedAt),
        inArray(taskKey, keys),
      ),
    )
    .orderBy(asc(projects.key), asc(tasks.number));
  const scope = await projectScope(db, viewer);
  return rows
    .filter((r) => inScope(scope, r.projectId))
    .map((r) => ({
      key: `${r.projectKey}-${r.number}`,
      title: r.title,
      projectKey: r.projectKey,
      statusCategory: r.statusCategory,
    }));
}
