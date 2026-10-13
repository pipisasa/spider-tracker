import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { assertCanWrite, type ActorContext, type Viewer } from "./access";
import { recordActivity } from "./activity";
import { documentSkeleton, quoteOccursInSkeleton } from "./anchors";
import { assertCommentRate, mentionedActors, parseMentions } from "./comments";
import type { DocumentCommentDto, DocumentInboxKind } from "./contracts";
import { documentLinkLabels, findDocument } from "./documents";
import { DomainError } from "./errors";
import { publish } from "./events";
import { isUuid } from "./ids";
import { notifyDocument } from "./inbox";
import {
  createDocumentCommentInput,
  resolveDocumentCommentInput,
} from "./schemas";
import { parseInput } from "./validate";

// Comments on documents (ST-118), on the comments table next to task comments: the same Markdown
// bodies, @mentions, replies and agent loop guard. A top-level comment may quote the fragment it
// is about; it stays when that text changes and is reported `outdated`. A thread (a top-level
// comment and its replies) can be marked resolved. Reading them takes what reading the document
// takes; writing takes what commenting on a task takes (no guests).

const { comments } = schema;

type CommentRow = typeof comments.$inferSelect;
type DocumentRow = Awaited<ReturnType<typeof findDocument>>["document"];

/** Whether a quote occurs in the document as `viewer` reads it. */
type QuoteCheck = (quote: string) => boolean;

/**
 * Checks quotes against a document, its readable text built once (not per comment), with
 * `[[doc:<id>]]` links showing the titles the viewer sees, as the web app renders them.
 */
async function quoteCheck(
  db: Db | Tx,
  viewer: Viewer,
  document: Pick<DocumentRow, "content" | "format">,
): Promise<QuoteCheck> {
  let built: ReturnType<typeof documentSkeleton> | undefined;
  const label = await documentLinkLabels(
    db,
    viewer,
    document.content,
    document.format,
  );
  return (quote) =>
    quoteOccursInSkeleton(
      (built ??= documentSkeleton(document.content, document.format, label)),
      quote,
    );
}

function toDto(
  row: CommentRow,
  document: Pick<DocumentRow, "id" | "version">,
  occurs: QuoteCheck,
): DocumentCommentDto {
  return {
    id: row.id,
    documentId: document.id,
    parentId: row.parentId,
    authorId: row.authorId,
    body: row.body,
    quote: row.quote,
    outdated: row.quote !== null && !occurs(row.quote),
    documentVersion: row.documentVersion ?? document.version,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

function commentsOf(db: Db | Tx, documentId: string) {
  return db
    .select()
    .from(comments)
    .where(and(eq(comments.documentId, documentId), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/** A document's comments, oldest first; replies point at their parent with parentId. */
export async function listDocumentComments(
  db: Db,
  viewer: Viewer,
  documentId: string,
): Promise<DocumentCommentDto[]> {
  const { document } = await findDocument(db, viewer, documentId);
  const rows = await commentsOf(db, document.id);
  const occurs = rows.some((row) => row.quote !== null)
    ? await quoteCheck(db, viewer, document)
    : () => true;
  return rows.map((row) => toDto(row, document, occurs));
}

/** The top-level comment a comment's thread hangs from. */
function rootOf(
  byId: Map<string, Pick<CommentRow, "id" | "parentId">>,
  id: string,
): string {
  const seen = new Set<string>();
  let current = byId.get(id);
  while (
    current?.parentId &&
    byId.has(current.parentId) &&
    !seen.has(current.id)
  ) {
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return current?.id ?? id;
}

/**
 * Comments on a document and notifies: mentioned members (`document_mention`), the author of the
 * comment replied to (`document_reply`), and the document's author and everyone else in the
 * thread (`document_comment`). A `quote` (top-level comments only) must occur in the document.
 * A reply to a resolved thread reopens it, as in Google Docs: the reply would be hidden otherwise.
 */
export async function addDocumentComment(
  db: Db,
  ctx: ActorContext,
  documentId: string,
  input: unknown,
): Promise<DocumentCommentDto> {
  assertCanWrite(ctx);
  const data = parseInput(createDocumentCommentInput, input);
  return db.transaction(async (tx) => {
    const { document, scope } = await findDocument(tx, ctx, documentId);
    await assertCommentRate(
      tx,
      ctx,
      eq(comments.documentId, document.id),
      "document",
    );

    const quote = data.quote ?? null;
    // Only a top-level comment quotes, so only it reads the document's link labels.
    let occurs: QuoteCheck = () => true;
    let parentAuthor: string | undefined;
    let threadAuthors: string[] = [];
    let reopen: string | null = null;
    if (data.parentId) {
      if (quote !== null)
        throw new DomainError(
          "validation",
          "A reply can't quote: it belongs to its thread's quote",
        );
      const thread = await tx
        .select({
          id: comments.id,
          parentId: comments.parentId,
          authorId: comments.authorId,
          resolvedAt: comments.resolvedAt,
        })
        .from(comments)
        .where(
          and(eq(comments.documentId, document.id), isNull(comments.deletedAt)),
        );
      const parent = thread.find((c) => c.id === data.parentId);
      if (!parent)
        throw new DomainError(
          "validation",
          "Parent comment not found on this document",
        );
      parentAuthor = parent.authorId;
      const byId = new Map(thread.map((c) => [c.id, c]));
      const root = rootOf(byId, parent.id);
      threadAuthors = thread
        .filter((c) => rootOf(byId, c.id) === root)
        .map((c) => c.authorId);
      if (byId.get(root)?.resolvedAt) reopen = root;
    } else if (quote !== null) {
      occurs = await quoteCheck(tx, ctx, document);
      if (!occurs(quote))
        throw new DomainError(
          "validation",
          "The quoted text isn't in the document's current version. Quote plain text from it: a selection across a link, image or formatting may not match; select a shorter part",
        );
    }

    const [comment] = await tx
      .insert(comments)
      .values({
        orgId: ctx.orgId,
        documentId: document.id,
        parentId: data.parentId ?? null,
        authorId: ctx.actorId,
        body: data.body,
        quote,
        documentVersion: document.version,
      })
      .returning();
    if (!comment) throw new Error("Failed to add comment");
    if (reopen) {
      await tx
        .update(comments)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(eq(comments.id, reopen));
      await recordActivity(tx, ctx, {
        entityType: "document",
        entityId: document.id,
        action: "comment.reopened",
        changes: { commentId: reopen, replyId: comment.id },
      });
    }

    const handles = parseMentions(data.body);
    const mentioned = await mentionedActors(tx, ctx, handles);
    // Order matters: the first entry per recipient wins, so a mention beats a reply, a reply a plain comment.
    const entry = (recipientId: string, kind: DocumentInboxKind) => ({
      recipientId,
      kind,
      commentId: comment.id,
    });
    await notifyDocument(tx, ctx, document.id, [
      ...mentioned.map((m) => entry(m.id, "document_mention")),
      ...(parentAuthor ? [entry(parentAuthor, "document_reply")] : []),
      entry(document.createdBy, "document_comment"),
      ...threadAuthors.map((id) => entry(id, "document_comment")),
    ]);
    await recordActivity(tx, ctx, {
      entityType: "document",
      entityId: document.id,
      action: "comment.created",
      changes: {
        commentId: comment.id,
        mentions: handles,
        ...(quote !== null ? { quote } : {}),
      },
    });
    await publish(tx, {
      type: "document.commented",
      orgId: ctx.orgId,
      documentId: document.id,
      ...scope,
    });
    return toDto(comment, document, occurs);
  });
}

/** Marks a thread (a top-level comment) resolved, or reopens it; a repeat changes nothing. */
export async function resolveDocumentComment(
  db: Db,
  ctx: ActorContext,
  documentId: string,
  commentId: string,
  input: unknown,
): Promise<DocumentCommentDto> {
  assertCanWrite(ctx);
  const { resolved } = parseInput(resolveDocumentCommentInput, input);
  return db.transaction(async (tx) => {
    const { document, scope } = await findDocument(tx, ctx, documentId);
    const [current] = isUuid(commentId)
      ? await tx
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, commentId),
              eq(comments.documentId, document.id),
              isNull(comments.deletedAt),
            ),
          )
          .limit(1)
      : [];
    if (!current)
      throw new DomainError("not_found", "Comment not found on this document");
    if (current.parentId)
      throw new DomainError(
        "validation",
        "Only a thread's first comment can be resolved",
      );
    const occurs =
      current.quote === null ? () => true : await quoteCheck(tx, ctx, document);
    if ((current.resolvedAt !== null) === resolved)
      return toDto(current, document, occurs);

    const [saved] = await tx
      .update(comments)
      .set(
        resolved
          ? { resolvedAt: new Date(), resolvedBy: ctx.actorId }
          : { resolvedAt: null, resolvedBy: null },
      )
      .where(eq(comments.id, current.id))
      .returning();
    if (!saved) throw new Error("Failed to resolve comment");
    await recordActivity(tx, ctx, {
      entityType: "document",
      entityId: document.id,
      action: resolved ? "comment.resolved" : "comment.reopened",
      changes: { commentId: current.id },
    });
    await publish(tx, {
      type: "document.commented",
      orgId: ctx.orgId,
      documentId: document.id,
      ...scope,
    });
    return toDto(saved, document, occurs);
  });
}
