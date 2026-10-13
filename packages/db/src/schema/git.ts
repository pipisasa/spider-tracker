import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { repos } from "./repos";
import { organizations } from "./tenancy";
import { tasks } from "./work";

// Branches, commits and pull requests linked to tasks (ST-84), from GitHub webhooks (create,
// delete, push, pull_request). A task key counts only when its project is attached to the repo.

// A repo's pull requests that link to at least one task. `github_updated_at` is the PR's
// `updated_at` on GitHub: an event older than the stored one is stale and changes nothing
// (webhooks can arrive out of order).
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    // "merged" is final: a merged PR can't be reopened.
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull(),
    draft: boolean("draft").notNull().default(false),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    // The GitHub login of who opened it.
    authorLogin: text("author_login"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    githubUpdatedAt: timestamp("github_updated_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("pull_requests_repo_number_key").on(t.repoId, t.number),
    check(
      "pull_requests_state_check",
      sql`${t.state} in ('open', 'closed', 'merged')`,
    ),
  ],
);

// One row per task and git object: a branch (`ref` is its name), a commit (the full sha) or a
// pull request (its number, with `pull_request_id`). `via` is how the task key was found, the
// strongest when several match: a closing keyword ("fixes ST-12"), the branch name, the PR title,
// the PR body or the commit message. Status automation (ST-85) acts only on closing, branch and
// title matches.
export const gitLinks = pgTable(
  "git_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["branch", "commit", "pull_request"],
    }).notNull(),
    ref: text("ref").notNull(),
    pullRequestId: uuid("pull_request_id").references(() => pullRequests.id, {
      onDelete: "cascade",
    }),
    via: text("via", {
      enum: ["closing", "branch", "title", "body", "message"],
    }).notNull(),
    // Commits: the first line of the message and the author (GitHub login, or the git name).
    title: text("title"),
    author: text("author"),
    // Commits: when committed; branches: when first seen.
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    // Branches: deleted on GitHub (the link stays).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("git_links_task_ref_key").on(t.taskId, t.repoId, t.kind, t.ref),
    index("git_links_repo_ref_idx").on(t.repoId, t.kind, t.ref),
    index("git_links_pull_request_idx").on(t.pullRequestId),
    check(
      "git_links_kind_check",
      sql`${t.kind} in ('branch', 'commit', 'pull_request')`,
    ),
    check(
      "git_links_via_check",
      sql`${t.via} in ('closing', 'branch', 'title', 'body', 'message')`,
    ),
    check(
      "git_links_pull_request_check",
      sql`(${t.kind} = 'pull_request') = (${t.pullRequestId} is not null)`,
    ),
  ],
);
