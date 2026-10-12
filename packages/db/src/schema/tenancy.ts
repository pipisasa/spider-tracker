import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
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

// Agent-only settings for actors with type "agent".
export const agents = pgTable("agents", {
  actorId: uuid("actor_id")
    .primaryKey()
    .references(() => actors.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["external", "hosted"] }).notNull().default("external"),
  // People are deactivated, not deleted; this cascade only matters when a whole organization is removed.
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => actors.id, { onDelete: "cascade" }),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// API keys: only a SHA-256 hash is stored; the key is shown once on creation.
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** First characters of the key (e.g. "spt_a1b2"), to recognise it in lists. */
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_tokens_actor_idx").on(t.actorId)],
);

// Invitation codes: anyone signed in with a valid code joins the organization with its role.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Normalised: uppercase, no separators (shown as ABCD-EFGH). */
    code: text("code").notNull().unique(),
    role: memberRole("role").notNull().default("member"),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invitations_org_idx").on(t.orgId),
    check("invitations_role_not_owner", sql`${t.role} <> 'owner'`),
  ],
);
