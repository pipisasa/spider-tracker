import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";
import { documents } from "./documents";
import { tasks } from "./work";

// Comments by people and agents (Markdown, @mentions) under a task or, since ST-118, a document:
// exactly one of task_id and document_id is set. A document comment may quote the fragment it is
// about (`quote`, top-level comments only) and records the version it was posted on; a top-level
// document comment can be marked resolved.
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "set null" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => actors.id),
    body: text("body").notNull(),
    /** Document comments: the text of the document the comment is about; null for the whole document. */
    quote: text("quote"),
    /** Document comments: the document's version when the comment was posted. */
    documentVersion: integer("document_version"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => actors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("comments_task_idx").on(t.taskId, t.createdAt),
    index("comments_document_idx").on(t.documentId, t.createdAt),
    check("comments_subject", sql`(${t.taskId} is null) <> (${t.documentId} is null)`),
    check("comments_quote_on_documents", sql`${t.quote} is null or ${t.documentId} is not null`),
  ],
);

// Per-actor inbox: mentions, assignments, comments and replies on their tasks, changes of the
// rules of their projects (`rules`, ST-111) and comments on documents (`document_*`, ST-118):
// those two have a document instead of a task.
// The identity id doubles as a cursor for agents that wait for new items.
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["mention", "assigned", "comment", "reply", "rules", "document_mention", "document_comment", "document_reply"],
    }).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    /** Who caused it (the commenter or assigner). */
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("inbox_recipient_idx").on(t.recipientId, t.id),
    check("inbox_items_subject", sql`${t.taskId} is not null or ${t.documentId} is not null`),
  ],
);
