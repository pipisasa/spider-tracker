import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import {
  aliasedTable,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { projectScope, type ActorContext } from "./access";
import type {
  DocumentInboxKind,
  InboxItemDto,
  InboxKind,
  TaskInboxKind,
} from "./contracts";
import { publish } from "./events";
import { inboxQuery, markInboxReadInput } from "./schemas";
import { parseInput } from "./validate";

const { actors, comments, documents, inboxItems, projects, tasks } = schema;

type InboxEntry<K> = { recipientId: string; kind: K; commentId?: string };

/** Inserts one item per recipient (the first entry per recipient wins); never for the actor. */
async function insertItems(
  tx: Tx,
  ctx: ActorContext,
  subject: { taskId: string } | { documentId: string },
  entries: InboxEntry<InboxKind>[],
) {
  const seen = new Set<string>([ctx.actorId]);
  const rows = entries.filter((e) =>
    seen.has(e.recipientId) ? false : seen.add(e.recipientId),
  );
  if (rows.length === 0) return;
  await tx.insert(inboxItems).values(
    rows.map((e) => ({
      orgId: ctx.orgId,
      recipientId: e.recipientId,
      kind: e.kind,
      ...subject,
      commentId: e.commentId ?? null,
      actorId: ctx.actorId,
    })),
  );
  await publish(tx, {
    type: "inbox.created",
    orgId: ctx.orgId,
    recipientIds: rows.map((r) => r.recipientId),
  });
}

/** Adds inbox items for a task event; never notifies the actor about their own action. */
export async function notify(
  tx: Tx,
  ctx: ActorContext,
  taskId: string,
  entries: InboxEntry<TaskInboxKind>[],
) {
  await insertItems(tx, ctx, { taskId }, entries);
}

/** Adds inbox items about a comment on a document (ST-118); never for the commenter. */
export async function notifyDocument(
  tx: Tx,
  ctx: ActorContext,
  documentId: string,
  entries: InboxEntry<DocumentInboxKind>[],
) {
  await insertItems(tx, ctx, { documentId }, entries);
}

/** Adds a `rules` item (ST-111) about a project's rules document for each recipient. */
export async function notifyRulesChanged(
  tx: Tx,
  ctx: ActorContext,
  documentId: string,
  recipientIds: string[],
) {
  const rows = [...new Set(recipientIds)].filter((id) => id !== ctx.actorId);
  if (rows.length === 0) return;
  await tx.insert(inboxItems).values(
    rows.map((recipientId) => ({
      orgId: ctx.orgId,
      recipientId,
      kind: "rules" as const,
      documentId,
      actorId: ctx.actorId,
    })),
  );
  await publish(tx, {
    type: "inbox.created",
    orgId: ctx.orgId,
    recipientIds: rows,
  });
}

const sender = aliasedTable(actors, "sender");
/** The task a task document belongs to (ST-134): deleted, it hides the document. */
const documentTask = aliasedTable(tasks, "document_task");

/** The acting actor's inbox, oldest first; `after` returns only newer items (a cursor). */
export async function listInbox(
  db: Db,
  ctx: ActorContext,
  query: unknown = {},
): Promise<InboxItemDto[]> {
  const { after, unread, limit, kinds } = parseInput(inboxQuery, query);
  const scope = await projectScope(db, ctx);
  const rows = await db
    .select({
      item: inboxItems,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      documentTitle: documents.title,
      projectKey: projects.key,
      comment: {
        id: comments.id,
        body: comments.body,
        deletedAt: comments.deletedAt,
      },
      from: {
        id: sender.id,
        handle: sender.handle,
        name: sender.name,
        type: sender.type,
      },
    })
    .from(inboxItems)
    // An item is about a task, or (kinds `rules` and `document_*`) about a document, which may be
    // organization-wide (no project).
    .leftJoin(tasks, eq(inboxItems.taskId, tasks.id))
    .leftJoin(documents, eq(inboxItems.documentId, documents.id))
    .leftJoin(documentTask, eq(documents.taskId, documentTask.id))
    .leftJoin(
      projects,
      eq(
        projects.id,
        sql`coalesce(${tasks.projectId}, ${documents.projectId})`,
      ),
    )
    .innerJoin(sender, eq(inboxItems.actorId, sender.id))
    .leftJoin(comments, eq(inboxItems.commentId, comments.id))
    .where(
      and(
        eq(inboxItems.recipientId, ctx.actorId),
        eq(inboxItems.orgId, ctx.orgId),
        inArray(inboxItems.kind, kinds),
        or(
          and(isNotNull(inboxItems.taskId), isNull(tasks.deletedAt)),
          and(
            isNull(inboxItems.taskId),
            isNotNull(documents.id),
            isNull(documents.deletedAt),
            // A task document goes with its task, as everywhere else (findDocument).
            isNull(documentTask.deletedAt),
          ),
        ),
        // A `rules` item only while its document is still the rules of a live project (ST-128,
        // ST-139): not after the rules were replaced or cleared, the document moved away or was
        // deleted, or the project was archived.
        or(
          ne(inboxItems.kind, "rules"),
          and(
            eq(projects.rulesDocumentId, inboxItems.documentId),
            isNull(projects.archivedAt),
          ),
        ),
        // Organization-wide documents are visible to every member, scoped agents included.
        scope
          ? or(
              inArray(projects.id, [...scope]),
              and(isNull(inboxItems.taskId), isNull(documents.projectId)),
            )
          : undefined,
        after !== undefined ? gt(inboxItems.id, after) : undefined,
        unread ? isNull(inboxItems.readAt) : undefined,
      ),
    )
    .orderBy(asc(inboxItems.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.item.id,
    kind: r.item.kind,
    createdAt: r.item.createdAt.toISOString(),
    readAt: r.item.readAt?.toISOString() ?? null,
    task:
      r.taskNumber !== null && r.taskTitle !== null
        ? { key: `${r.projectKey}-${r.taskNumber}`, title: r.taskTitle }
        : null,
    document:
      r.item.documentId && r.documentTitle !== null
        ? {
            id: r.item.documentId,
            title: r.documentTitle,
            projectKey: r.projectKey ?? null,
          }
        : null,
    comment:
      r.comment && !r.comment.deletedAt
        ? { id: r.comment.id, body: r.comment.body }
        : null,
    from: r.from,
  }));
}

/**
 * Marks the actor's items read, by id or everything of the given kinds (default: the task kinds)
 * up to a cursor. Returns how many changed.
 */
export async function markInboxRead(
  db: Db,
  ctx: ActorContext,
  input: unknown,
): Promise<number> {
  const { ids, upTo, kinds } = parseInput(markInboxReadInput, input);
  const rows = await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(inboxItems.recipientId, ctx.actorId),
        isNull(inboxItems.readAt),
        ids ? inArray(inboxItems.id, ids) : undefined,
        // Only the kinds the client listed: older clients never fetch `rules` and `document_*` items.
        upTo !== undefined
          ? and(lte(inboxItems.id, upTo), inArray(inboxItems.kind, kinds))
          : undefined,
      ),
    )
    .returning({ id: inboxItems.id });
  return rows.length;
}
