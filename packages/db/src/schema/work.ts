import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";

// Fractional-index keys must compare byte-wise; the default locale collation reorders them.
const sortKeyText = customType<{ data: string }>({ dataType: () => 'text collate "C"' });

export const statusCategory = pgEnum("status_category", [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Counter for task numbers (SPI-<n>); incremented in the task-creating transaction.
    taskSeq: integer("task_seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [unique("projects_org_key_key").on(t.orgId, t.key)],
);

export const statuses = pgTable(
  "statuses",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: statusCategory("category").notNull(),
    color: text("color"),
    position: integer("position").notNull(),
  },
  (t) => [unique("statuses_project_name_key").on(t.projectId, t.name)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    statusId: uuid("status_id")
      .notNull()
      .references(() => statuses.id),
    // 0 none, 1 urgent, 2 high, 3 medium, 4 low (Linear's order).
    priority: smallint("priority").notNull().default(0),
    parentId: uuid("parent_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    // Fractional index: ordering within a status column.
    sortKey: sortKeyText("sort_key").notNull(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => actors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("tasks_project_number_key").on(t.projectId, t.number),
    index("tasks_board_idx").on(t.projectId, t.statusId, t.sortKey),
    check("tasks_priority_range", sql`${t.priority} between 0 and 4`),
  ],
);

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => actors.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.actorId] }), index("task_assignees_actor_idx").on(t.actorId)],
);

// Append-only audit log (docs/data-model.md).
export const activity = pgTable(
  "activity",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    changes: jsonb("changes").$type<Record<string, unknown>>(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activity_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    // Agent presence (ST-70) reads an org's activity of the last few minutes.
    index("activity_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

// Organization-wide labels for tasks (ST-8).
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Unique regardless of case (ST-49).
  (t) => [uniqueIndex("tags_org_lower_name_key").on(t.orgId, sql`lower(${t.name})`)],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] }), index("task_tags_tag_idx").on(t.tagId)],
);

// Links between tasks (ST-10). Stored in one direction: "A blocks B", "A duplicates B",
// "A relates to B"; the reverse ("blocked by", "duplicated by") is derived when listing.
export const taskRelations = pgTable(
  "task_relations",
  {
    fromTaskId: uuid("from_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    toTaskId: uuid("to_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["blocks", "relates", "duplicates"] }).notNull(),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.fromTaskId, t.toTaskId, t.type] }),
    index("task_relations_to_idx").on(t.toTaskId),
    check("task_relations_not_self", sql`${t.fromTaskId} <> ${t.toTaskId}`),
    // `relates` is symmetric: stored smaller id first, so A-B and B-A can't both exist (ST-49).
    check("task_relations_relates_ordered", sql`${t.type} <> 'relates' or ${t.fromTaskId} < ${t.toTaskId}`),
  ],
);

// Projects an agent may see (ST-31). Agents with `agents.scoped` see only these; others see every project.
export const agentProjects = pgTable(
  "agent_projects",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.projectId] }), index("agent_projects_project_idx").on(t.projectId)],
);
