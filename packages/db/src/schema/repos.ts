import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { actors, organizations } from "./tenancy";
import { projects, tasks } from "./work";

// Git repos and the apps in them (ST-92). A repo belongs to the organization and is attached to
// projects through `project_repos` (a repo can serve several projects). It is added by its remote
// URL; the GitHub App (ST-82) later attaches an installation to an existing row instead of
// creating one. Apps are the deployable parts of a repo that releases (ST-93) version and ship.
export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The GitHub remote `owner/name`, with GitHub's casing as given.
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    // GitHub's installation id once the GitHub App is installed on the repo (ST-82); null until then.
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // GitHub names are case-insensitive: one row per remote and organization.
  (t) => [uniqueIndex("repos_org_remote_key").on(t.orgId, sql`lower(${t.owner})`, sql`lower(${t.name})`)],
);

export const projectRepos = pgTable(
  "project_repos",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.repoId] }), index("project_repos_repo_idx").on(t.repoId)],
);

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    // Lower-case, e.g. "web"; part of release tags ("web-2026.10.12").
    name: text("name").notNull(),
    // Where the app lives in the repo, e.g. "web/app" ("." for the whole repo).
    path: text("path").notNull(),
    // Shared packages it depends on, e.g. ["packages/core"]: commits there touch the app too.
    sharedPaths: text("shared_paths").array().notNull().default(sql`'{}'::text[]`),
    versioning: text("versioning", { enum: ["date", "semver"] }).notNull(),
    // Deploy order, e.g. ["staging", "prod"]; empty when a release is the only "deploy" (a CLI).
    environments: text("environments").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("apps_repo_name_key").on(t.repoId, t.name),
    check("apps_versioning_check", sql`${t.versioning} in ('date', 'semver')`),
  ],
);


// What a release (a task of kind "release", ST-93) ships: the repos it links, and a version per app.
// A repo may be attached to other projects than the release's, as long as its creator can reach it.
export const releaseRepos = pgTable(
  "release_repos",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.repoId] }), index("release_repos_repo_idx").on(t.repoId)],
);

export const releaseApps = pgTable(
  "release_apps",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    // In the app's versioning: "2026.10.13" (date) or "0.1.8" (semver).
    version: text("version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.appId] }), index("release_apps_app_idx").on(t.appId)],
);
