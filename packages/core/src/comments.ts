import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import { assertCanWrite, type ActorContext, type Viewer } from "./access";
import { recordActivity } from "./activity";
import type { CommentDto, TaskInboxKind } from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import { notify } from "./inbox";
import { createCommentInput, type CreateCommentInput } from "./schemas";
import { findTask, type FoundTask } from "./tasks";
import { parseInput } from "./validate";

const { actors, comments, taskAssignees } = schema;

/** Loop guard: an agent posts at most this many comments per task (or document) per minute. */
export const AGENT_COMMENT_LIMIT = { perMinute: 5 };

/** Handles mentioned as @handle (not inside emails such as a@b.com). */
export function parseMentions(body: string): string[] {
  const handles = new Set<string>();
  for (const match of body.matchAll(/(?<![\w@.])@([a-z0-9]+(?:-[a-z0-9]+)*)/gi)) {
    if (match[1]) handles.add(match[1].toLowerCase());
  }
  return [...handles];
}

/** Active members of the organization named by `handles`. */
export async function mentionedActors(tx: Tx, ctx: ActorContext, handles: string[]): Promise<{ id: string }[]> {
  if (handles.length === 0) return [];
  return tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.orgId, ctx.orgId), inArray(actors.handle, handles), isNull(actors.deactivatedAt)));
}

/** The agent loop guard: an agent posts at most AGENT_COMMENT_LIMIT comments per minute on one task or document. */
export async function assertCommentRate(tx: Tx, ctx: ActorContext, subject: SQL, what: "task" | "document") {
  const [author] = await tx.select({ type: actors.type }).from(actors).where(eq(actors.id, ctx.actorId)).limit(1);
  if (author?.type !== "agent") return;
  const recent = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(and(subject, eq(comments.authorId, ctx.actorId), gt(comments.createdAt, new Date(Date.now() - 60_000))));
  if (recent.length >= AGENT_COMMENT_LIMIT.perMinute) {
    throw new DomainError("rate_limited", `Too many comments on this ${what} in the last minute. Slow down`);
  }
}

function toCommentDto(row: typeof comments.$inferSelect, taskKey: string): CommentDto {
  return {
    id: row.id,
    taskKey,
    parentId: row.parentId,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

export async function listComments(db: Db, viewer: Viewer, taskKey: string): Promise<CommentDto[]> {
  const { task, projectKey } = await findTask(db, viewer, taskKey);
  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.taskId, task.id), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map((r) => toCommentDto(r, `${projectKey}-${task.number}`));
}

/**
 * Adds a comment and notifies: mentioned members ("mention"), the parent comment's
 * author ("reply") and the task's assignees ("comment").
 */
export async function addComment(db: Db, ctx: ActorContext, taskKey: string, input: unknown): Promise<CommentDto> {
  assertCanWrite(ctx);
  const data = parseInput(createCommentInput, input);
  return db.transaction(async (tx) => postComment(tx, ctx, await findTask(tx, ctx, taskKey), data));
}

/**
 * The body of addComment for a task found in `tx` (core only; callers check write access and parse
 * the input): the agent rate limit, the insert, notifications, activity and the event.
 */
export async function postComment(tx: Tx, ctx: ActorContext, { task, projectKey }: FoundTask, data: CreateCommentInput): Promise<CommentDto> {
  await assertCommentRate(tx, ctx, eq(comments.taskId, task.id), "task");

  let parentAuthor: string | undefined;
  if (data.parentId) {
    const [parent] = await tx
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(and(eq(comments.id, data.parentId), eq(comments.taskId, task.id), isNull(comments.deletedAt)))
      .limit(1);
    if (!parent) throw new DomainError("validation", "Parent comment not found on this task");
    parentAuthor = parent.authorId;
  }

  const [comment] = await tx
    .insert(comments)
    .values({ orgId: ctx.orgId, taskId: task.id, parentId: data.parentId ?? null, authorId: ctx.actorId, body: data.body })
    .returning();
  if (!comment) throw new Error("Failed to add comment");

  const handles = parseMentions(data.body);
  const mentioned = await mentionedActors(tx, ctx, handles);
  const assignees = await tx
    .select({ id: taskAssignees.actorId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, task.id));

  // Order matters: the first entry per recipient wins, so a mention beats a plain comment.
  const entries: { recipientId: string; kind: TaskInboxKind; commentId: string }[] = [
    ...mentioned.map((m) => ({ recipientId: m.id, kind: "mention" as const, commentId: comment.id })),
    ...(parentAuthor ? [{ recipientId: parentAuthor, kind: "reply" as const, commentId: comment.id }] : []),
    ...assignees.map((a) => ({ recipientId: a.id, kind: "comment" as const, commentId: comment.id })),
  ];
  await notify(tx, ctx, task.id, entries);
  await recordActivity(tx, ctx, {
    entityType: "task",
    entityId: task.id,
    action: "comment.created",
    changes: { commentId: comment.id, mentions: handles },
  });

  await publish(tx, { type: "comment.created", orgId: ctx.orgId, taskKey: `${projectKey}-${task.number}` });
  return toCommentDto(comment, `${projectKey}-${task.number}`);
}
