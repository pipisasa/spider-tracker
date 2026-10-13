import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";
import { projects } from "./work";

// Saved filters of a project's board/list (ST-15). Personal unless `shared`, in which case
// everyone who can see the project sees it. `filters` is validated by `viewFiltersSchema` in core.
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerActorId: uuid("owner_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    shared: boolean("shared").notNull().default(false),
    view: text("view", { enum: ["board", "list"] })
      .notNull()
      .default("board"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("saved_views_project_idx").on(t.projectId),
    check("saved_views_view_check", sql`${t.view} in ('board', 'list')`),
  ],
);
