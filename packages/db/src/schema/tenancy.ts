import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const actorType = pgEnum("actor_type", ["human", "agent"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member", "guest"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// People and agents share one table (docs/data-model.md).
export const actors = pgTable(
  "actors",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: actorType("type").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    handle: text("handle").notNull(),
    avatarUrl: text("avatar_url"),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [
    unique("actors_org_handle_key").on(t.orgId, t.handle),
    unique("actors_org_user_key").on(t.orgId, t.userId),
    check("actors_human_has_user", sql`${t.type} <> 'human' or ${t.userId} is not null`),
  ],
);
