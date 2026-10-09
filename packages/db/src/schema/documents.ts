import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";
import { projects, tasks } from "./work";

// Markdown / HTML documents at organization, project or task level (ST-21).
// `version` counts saves; every save also writes a document_versions row, so the
// history includes the current version.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    format: text("format", { enum: ["md", "html"] }).notNull(),
    content: text("content").notNull().default(""),
    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => actors.id),
    // Whoever saved the current version.
    authorId: uuid("author_id")
      .notNull()
      .references(() => actors.id),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("documents_scope_idx")
      .on(t.orgId, t.projectId, t.taskId)
      .where(sql`${t.deletedAt} is null`),
    check("documents_format_check", sql`${t.format} in ('md', 'html')`),
    check(
      "documents_task_needs_project",
      sql`${t.taskId} is null or ${t.projectId} is not null`,
    ),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    format: text("format", { enum: ["md", "html"] }).notNull(),
    content: text("content").notNull(),
    authorId: uuid("author_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.version] })],
);
