import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
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
    accountType: text("account_type", {
      enum: ["User", "Organization"],
    }).notNull(),
    // "all" repositories of the account, or only "selected" ones.
    repositorySelection: text("repository_selection", {
      enum: ["all", "selected"],
    }).notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    connectedBy: uuid("connected_by").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("github_installations_org_idx").on(t.orgId),
    check(
      "github_installations_account_type_check",
      sql`${t.accountType} in ('User', 'Organization')`,
    ),
    check(
      "github_installations_repository_selection_check",
      sql`${t.repositorySelection} in ('all', 'selected')`,
    ),
  ],
);

// GitHub webhook deliveries (ST-83), by GitHub's X-GitHub-Delivery id. The row is inserted first
// in the transaction that handles the event, so a redelivery (or two copies arriving at once)
// is handled once: the second insert waits for the first transaction and then does nothing.
// Deliveries for installations no organization has connected are kept too (`org_id` null).
export const githubDeliveries = pgTable(
  "github_deliveries",
  {
    id: text("id").primaryKey(),
    // X-GitHub-Event, e.g. "installation"; and the payload's `action`, when it has one.
    event: text("event").notNull(),
    action: text("action"),
    // No foreign key: the installation may be unknown here, or deleted since.
    installationId: bigint("installation_id", { mode: "number" }),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    // "processed" when it changed something for an organization; "ignored" otherwise.
    result: text("result", { enum: ["processed", "ignored"] })
      .notNull()
      .default("ignored"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("github_deliveries_received_at_idx").on(t.receivedAt),
    check(
      "github_deliveries_result_check",
      sql`${t.result} in ('processed', 'ignored')`,
    ),
  ],
);

// Install links issued for the GitHub App's setup flow (ST-137): the nonce of each signed `state`.
// The setup callback deletes the row to use the state, so a state works once; rows past
// `expires_at` are cleaned up when new links are issued.
export const githubInstallStates = pgTable(
  "github_install_states",
  {
    nonce: text("nonce").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("github_install_states_expires_at_idx").on(t.expiresAt)],
);
