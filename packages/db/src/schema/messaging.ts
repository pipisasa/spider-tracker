import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";
import { tasks } from "./work";

// Comments under tasks, by people and agents (Markdown, @mentions).
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "set null" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => actors.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("comments_task_idx").on(t.taskId, t.createdAt)],
);

// Per-actor inbox: mentions, assignments, comments and replies on their tasks.
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
    kind: text("kind", { enum: ["mention", "assigned", "comment", "reply"] }).notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    /** Who caused it (the commenter or assigner). */
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("inbox_recipient_idx").on(t.recipientId, t.id)],
);
