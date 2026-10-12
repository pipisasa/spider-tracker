import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";

// GitHub App installations connected to an organization (ST-82). The id is GitHub's installation
// id. An installation belongs to one organization here: connecting it from another one is refused.
// Its repositories are rows in `repos` whose `github_installation_id` points here.
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The GitHub account the App is installed on.
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type", { enum: ["User", "Organization"] }).notNull(),
    // "all" repositories of the account, or only "selected" ones.
    repositorySelection: text("repository_selection", { enum: ["all", "selected"] }).notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    connectedBy: uuid("connected_by").references(() => actors.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("github_installations_org_idx").on(t.orgId),
    check("github_installations_account_type_check", sql`${t.accountType} in ('User', 'Organization')`),
    check("github_installations_repository_selection_check", sql`${t.repositorySelection} in ('all', 'selected')`),
  ],
);
