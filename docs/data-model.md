# Data model

[← Project overview](./PROJECT.md) · Database: Postgres (see [decisions.md](./decisions.md))

## Overview

Identity tables (users, sessions, OAuth clients and tokens) belong to Better Auth; see [auth.md](./auth.md#what-owns-what). The tables below are ours.

```
organizations ─┬─ actors (human | agent | integration) ── agents (1:1 config), api_tokens
               ├─ tags, custom_field_defs, github_installations, github_install_states, github_deliveries, repos, apps, documents
               └─ projects ─┬─ statuses, cycles, custom_field_defs (project-scoped)
                            └─ tasks ─┬─ task_assignees → actors
                                      ├─ task_tags, task_relations, sub-tasks (parent_id)
                                      ├─ comments, documents, git_links → repos, pull_requests
                                      └─ agent_runs ── agent_run_events
activity (append-only log for everything)
```

## Entities

| Entity                      | Purpose                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Organization**            | The tenant boundary; owns everything else                                                                                                                                                                                                                                                                                     |
| **Actor**                   | A member: a person or an agent; or an integration bot (the GitHub one, ST-82) that git-driven changes are attributed to                                                                                                                                                                                                       |
| **Agent**                   | Extra configuration for agent actors (model, prompt, tools, limits)                                                                                                                                                                                                                                                           |
| **API token**               | Hashed API keys for external agents and CI                                                                                                                                                                                                                                                                                    |
| **Project**                 | A unit of work with a key (`SPI`), workflow and settings                                                                                                                                                                                                                                                                      |
| **Status**                  | A workflow state of one project and task kind (ST-90), mapped to a fixed category                                                                                                                                                                                                                                             |
| **Cycle**                   | A sprint or milestone                                                                                                                                                                                                                                                                                                         |
| **Task**                    | A unit of work of a kind (`task`, `release` or `milestone`, ST-90); supports sub-tasks, relations, assignees, tags and custom fields                                                                                                                                                                                          |
| **Tag**                     | An organization-wide label                                                                                                                                                                                                                                                                                                    |
| **Custom field definition** | A user-defined field at organization or project scope                                                                                                                                                                                                                                                                         |
| **GitHub installation**     | The GitHub App installed on a GitHub account and connected to one organization (ST-82); keyed by GitHub's installation id                                                                                                                                                                                                     |
| **GitHub delivery**         | A webhook delivery GitHub sent (ST-83), by its `X-GitHub-Delivery` id: what makes each one handled once                                                                                                                                                                                                                       |
| **Repo**                    | An organization's GitHub repository (`owner/name`, default branch), attached to projects through `project_repos`; a GitHub installation that grants it sets `github_installation_id` (ST-82)                                                                                                                                  |
| **App**                     | A deployable part of one repo: folder, shared packages, versioning (`date` / `semver`) and ordered environments (ST-92)                                                                                                                                                                                                       |
| **Milestone**               | A task of kind `milestone` (ST-96): goal and "Done when" in its description, start and target dates; tasks of its project join through `tasks.milestone_id`, and sub-tasks without one inherit their parent's when the parent is in the same project (computed, not stored). The project's milestones by date are its roadmap |
| **Release**                 | A task of kind `release` (ST-93): links repos (`release_repos`) and apps with a version each (`release_apps`), includes Done tasks of any project (`tasks.release_id`), records `deployments` per app and environment (ST-94); marking it Released sets `shipped_at` on it and its tasks                                      |
| **Git link**                | A branch, commit or pull request linked to a task, with how its key was found (ST-84)                                                                                                                                                                                                                                         |
| **Pull request**            | A repo's GitHub pull request that links to a task: state, draft, branches, and its `updated_at` on GitHub for the out-of-order guard (ST-84)                                                                                                                                                                                  |
| **Document**                | Markdown or HTML content at organization, project or task level, with versions; one project document can be the project's **rules** for agents (`projects.rules_document_id`, ST-111)                                                                                                                                         |
| **File**                    | Metadata for an object stored in Cloudflare R2 (attachments, images, artifacts)                                                                                                                                                                                                                                               |
| **Comment**                 | A threaded Markdown comment on a task or (ST-118) a document; a document comment may quote the fragment it is about and its thread can be resolved                                                                                                                                                                            |
| **Inbox item**              | A notification for one actor: mention, assignment, reply or comment on their task; or, about a document instead of a task, changed rules of their project (`rules`) or a comment on a document (`document_mention`, `document_reply`, `document_comment`); its id is a cursor for waiting clients                             |
| **Device code**             | A pending `spider login` (RFC 8628): hashed device code, user code, approver, expiry                                                                                                                                                                                                                                          |
| **Activity**                | Append-only audit log of every change                                                                                                                                                                                                                                                                                         |
| **Agent run**               | One execution of an agent on a task                                                                                                                                                                                                                                                                                           |
| **Agent run event**         | One streamed event from a run: messages, tool calls, approvals                                                                                                                                                                                                                                                                |

## Design decisions

| Decision                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One `actors` table for people and agents                            | Assignees, authors, mentions and the audit log all point at a single table. Agent-only settings live in `agents`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `org_id` on every main table                                        | Access control is one rule: the row's `org_id` must be in the user's organizations. It also makes per-organization filters fast.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| UUIDv7 primary keys + per-project numbers                           | UUIDv7 IDs sort by creation time and keep indexes efficient. `SPI-123` comes from `projects.task_seq`, incremented in the same transaction that inserts the task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Statuses belong to projects, each mapped to a fixed category        | Projects name their columns freely; automation and reports use the categories. Status automation from pull requests (ST-85, `projects.git_automation`) names categories, not statuses, and moves a task to the first status of that category in its own workflow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Statuses are per project **and** task kind (ST-90)                  | Releases and milestones move through their own workflows (Planned → On staging → Release review → Released; Planned → Active → Ready to close → Done), so `statuses.kind` splits a project's statuses into one workflow per kind; `position` orders a workflow. A task's kind is fixed at creation, and the composite foreign key `tasks (project_id, kind, status_id) → statuses (project_id, kind, id)` makes the database refuse a status of another project or kind. Names are unique per workflow regardless of case (status lookups by name are case-insensitive). Every new project gets the three default workflows (`DEFAULT_WORKFLOWS` in core); the migration gave existing projects the release and milestone ones. A status's category never changes; deleting one moves its tasks to another status of the same workflow first, and each workflow keeps an open and a done status. |
| Custom field values as JSON, keyed by field definition ID           | Renaming a field touches no data. A GIN index keeps filtering fast. The app's `core` package validates values against the definitions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sort_key` holds a fractional index                                 | Dragging a card changes one row instead of renumbering the column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Explicit columns on `documents` (not a generic "attached to" pair)  | Foreign keys and cascading deletes keep working.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Run events kept separate from comments                              | `agent_run_events` holds the full trace and chat; comments hold the clean result people read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Soft delete (`deleted_at`) on tasks, documents and comments         | Supports undo and keeps the audit history intact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Task dates are `date` columns, "overdue" uses the server's UTC date | Start and target dates (ST-91) are calendar days, `YYYY-MM-DD` everywhere, with no time zone to convert. A task is overdue when its target date is before today in UTC and its status isn't done or canceled (`isOverdue` in `@repo/core/schemas`); a team far from UTC may see a task turn overdue a few hours early or late. `start ≤ target` is checked in core (with the stored date when an update changes only one) and by the `tasks_dates_ordered` constraint.                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Schema

`uuidv7()` is built into Postgres 18. On older versions, generate IDs in the app instead.

```sql
-- ── enums ─────────────────────────────────────────────
create type actor_type      as enum ('human','agent');
create type member_role     as enum ('owner','admin','member','guest');
create type status_category as enum ('backlog','todo','in_progress','in_review','done','canceled');
create type field_type      as enum ('text','long_text','number','currency','date','datetime','boolean',
                                     'select','multi_select','url','email','actor','task_ref','repo_ref','app_ref');
create type run_status      as enum ('queued','running','needs_input','completed','failed','canceled');

-- ── tenancy & actors ─────────────────────────────────
create table organizations (
  id uuid primary key default uuidv7(),
  slug text unique not null, name text not null,
  settings jsonb not null default '{}', created_at timestamptz not null default now()
);

create table actors (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  type actor_type not null,
  user_id text references "user",             -- Better Auth user; set for humans only
  name text not null, handle text not null, avatar_url text,
  role member_role not null default 'member',
  deactivated_at timestamptz,
  unique (org_id, handle),
  check (type <> 'human' or user_id is not null)
);
-- actor_type: human | agent | integration. An integration (ST-82) is a per-org bot (the GitHub one,
-- handle "github", reserved for it): no user, no agents row, no API keys; left out of GET /members
-- (pickers) unless ?all=true, never assigned or mentioned.

create table invitations (                     -- join codes; anyone signed in with one joins with its role
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  code text unique not null,                  -- normalised: uppercase, no dashes (shown as ABCD-EFGH)
  role member_role not null default 'member' check (role <> 'owner'),
  created_by uuid references actors on delete set null,
  expires_at timestamptz not null,
  max_uses int,                               -- null = unlimited
  use_count int not null default 0,           -- incremented under a row lock when someone joins
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table agent_invites (                   -- one-time setup codes for a pending agent (ST-31)
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  code text unique not null,                  -- same format as invitations
  agent_id uuid not null references actors on delete cascade,  -- the pending agent, deactivated until accepted
  created_by uuid references actors on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table agent_projects (                  -- projects a scoped agent may see (agents.scoped: no rows left = nothing; unscoped = all)
  agent_id uuid references actors on delete cascade,
  project_id uuid references projects on delete cascade,
  primary key (agent_id, project_id)
);

create table agents (
  actor_id uuid primary key references actors on delete cascade,
  kind text not null check (kind in ('hosted','external')),
  owner_id uuid not null references actors,
  scoped boolean not null default false,      -- limited to agent_projects; stays set when those rows go
  provider text, model text, system_prompt text,
  tools jsonb not null default '[]',
  limits jsonb not null default '{}',         -- {max_cost_usd, max_tokens, require_approval:[...]}
  allowed_project_ids uuid[],                 -- null = all projects
  oauth_client_id text,                       -- set for MCP clients connected via OAuth
  status text not null default 'idle'
);

create table api_tokens (
  id uuid primary key default uuidv7(),
  actor_id uuid not null references actors on delete cascade,
  name text not null, token_hash text unique not null,
  scopes text[] not null default '{}',
  last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz
);

-- ── projects & workflow ──────────────────────────────
create table projects (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  key text not null, name text not null, description text,
  lead_id uuid references actors,
  task_seq int not null default 0,
  settings jsonb not null default '{}',
  rules_document_id uuid references documents on delete set null,  -- rules for agents: one of its own project-level documents (ST-111)
  git_automation jsonb,                       -- status automation from pull requests (ST-85): { enabled, draft, opened, merged, closed }; null = defaults
  archived_at timestamptz,
  unique (org_id, key)
);

create type task_kind as enum ('task','release','milestone');  -- ST-90

create table statuses (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects on delete cascade,
  kind task_kind not null default 'task',              -- one workflow per project and kind (ST-90)
  name text not null, category status_category not null,
  color text, position int not null,                   -- order within the kind's workflow
  unique (project_id, kind, id)                        -- target of tasks_status_fk
);
create unique index on statuses (project_id, kind, lower(name));

create table cycles (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects on delete cascade,
  name text not null, kind text not null default 'cycle', starts_on date, ends_on date
);

-- ── tasks ────────────────────────────────────────────
create table tasks (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations,
  project_id uuid not null references projects,
  number int not null,
  title text not null, description text,
  kind task_kind not null default 'task',              -- fixed at creation (ST-90)
  status_id uuid not null,
  priority smallint not null default 0 check (priority between 0 and 4),
  parent_id uuid references tasks,
  cycle_id uuid references cycles,
  estimate numeric,
  -- Plan dates (ST-91): calendar dates with no time zone, both optional; start ≤ target.
  start_date date, target_date date,
  -- Shipping (ST-93): Done means finished; a task ships in one release (a task of kind 'release').
  release_id uuid references tasks on delete set null,
  shipped_at timestamptz,                              -- when its release was marked Released (a release: when it was)
  no_code boolean not null default false,              -- nothing to ship: a Done task that needs no release
  -- Milestones (ST-96): a milestone (a task of kind 'milestone') of the same project; sub-tasks
  -- without one inherit the nearest ancestor's (computed on read, never stored).
  milestone_id uuid references tasks on delete set null,
  sort_key text not null,
  custom_fields jsonb not null default '{}',
  creator_id uuid not null references actors,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz, deleted_at timestamptz,
  search tsvector generated always as
    (to_tsvector('simple', title || ' ' || coalesce(description, ''))) stored,
  unique (project_id, number),
  -- The status is one of the workflow of the task's project and kind (ST-90).
  constraint tasks_status_fk foreign key (project_id, kind, status_id) references statuses (project_id, kind, id),
  constraint tasks_dates_ordered check (start_date is null or target_date is null or start_date <= target_date),
  constraint tasks_release_not_self check (release_id <> id),
  constraint tasks_milestone_not_self check (milestone_id <> id)
);
create index tasks_release_idx on tasks (release_id);
create index tasks_milestone_idx on tasks (milestone_id);
create index on tasks (project_id, status_id, sort_key) where deleted_at is null;
create index on tasks using gin (custom_fields jsonb_path_ops);
create index on tasks using gin (search);

create table task_assignees (
  task_id uuid references tasks on delete cascade,
  actor_id uuid references actors,
  assigned_by uuid references actors, assigned_at timestamptz not null default now(),
  primary key (task_id, actor_id)
);
create index on task_assignees (actor_id);

create table task_relations (
  from_task_id uuid references tasks on delete cascade,
  to_task_id   uuid references tasks on delete cascade,
  type text not null check (type in ('blocks','relates','duplicates')),
  primary key (from_task_id, to_task_id, type)
);

create table tags (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  name text not null, color text, group_name text,
  unique (org_id, name)
);
create table task_tags (
  task_id uuid references tasks on delete cascade, tag_id uuid references tags on delete cascade,
  primary key (task_id, tag_id)
);

-- Saved filter sets per project (ST-15). Personal unless shared; `filters` is validated by
-- viewFiltersSchema in core: { status?: id[], assignee?: (id|'me'|'none')[], priority?: 0-4[], tag?: id[], q?: text, overdue?: boolean }.
create table saved_views (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  project_id uuid not null references projects on delete cascade,
  owner_actor_id uuid not null references actors on delete cascade,
  name text not null,
  filters jsonb not null default '{}',
  shared boolean not null default false,
  view text not null default 'board' check (view in ('board','list')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- ── custom fields ────────────────────────────────────
create table custom_field_defs (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  project_id uuid references projects on delete cascade,   -- null = org-wide
  entity text not null check (entity in ('task','project','document')),
  key text not null, name text not null, type field_type not null,
  options jsonb,
  required boolean not null default false, default_value jsonb,
  position int not null default 0, archived_at timestamptz,
  unique nulls not distinct (org_id, project_id, entity, key)
);

-- ── repos, apps, git ─────────────────────────────────
-- ST-82: a GitHub App installation connected to one organization (another org connecting it is refused).
create table github_installations (
  id bigint primary key,                               -- GitHub's installation id
  org_id uuid not null references organizations on delete cascade,
  account_login text not null,                         -- the GitHub user or organization it is installed on
  account_type text not null check (account_type in ('User', 'Organization')),
  repository_selection text not null check (repository_selection in ('all', 'selected')),
  suspended_at timestamptz,
  connected_by uuid references actors on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index github_installations_org_idx on github_installations (org_id);

-- ST-137: install links in flight. The setup callback deletes the row to use the signed state, so it works
-- once; rows past expires_at are deleted whenever a new link is issued.
create table github_install_states (
  nonce text primary key,                              -- the state's random nonce
  org_id uuid not null references organizations on delete cascade,
  user_id text not null references "user" on delete cascade,
  expires_at timestamptz not null,                     -- 15 minutes after it was issued
  created_at timestamptz not null default now()
);
create index github_install_states_expires_at_idx on github_install_states (expires_at);

-- ST-83: GitHub webhook deliveries, by X-GitHub-Delivery. Inserted first (on conflict do nothing) in the
-- transaction that handles the event, so each delivery is handled once, even when copies arrive together.
-- Deliveries of installations no organization has connected are kept too (org_id null). Rows older than 30 days
-- are deleted a batch at a time after each new delivery (ST-138, pruneGithubDeliveries).
create table github_deliveries (
  id text primary key,                                 -- X-GitHub-Delivery (a GUID)
  event text not null,                                 -- X-GitHub-Event, e.g. 'installation'
  action text,                                         -- the payload's action, when it has one
  installation_id bigint,                              -- no foreign key: unknown here, or deleted since
  org_id uuid references organizations on delete set null,
  result text not null default 'ignored' check (result in ('processed', 'ignored')),
  received_at timestamptz not null default now()
);
create index github_deliveries_received_at_idx on github_deliveries (received_at);

-- Built in ST-92: repos added by remote URL. ST-82: connecting an installation sets
-- github_installation_id on the existing rows (matched by owner/name, any case) and adds the others.
create table repos (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  owner text not null, name text not null,             -- the GitHub remote owner/name, casing as given
  default_branch text not null default 'main',
  github_installation_id bigint references github_installations on delete set null,  -- null when added by URL only, or no longer granted
  created_by uuid references actors on delete set null,
  created_at timestamptz not null default now()
);
create unique index repos_org_remote_key on repos (org_id, lower(owner), lower(name));
create index repos_github_installation_idx on repos (github_installation_id);
create table project_repos (
  project_id uuid not null references projects on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, repo_id)
);
-- An app belongs to one repo; which tasks touch it comes from their commits' paths (ST-93/95).
create table apps (
  id uuid primary key default uuidv7(),
  repo_id uuid not null references repos on delete cascade,
  name text not null,                                  -- lower-case, part of release tags (web-2026.10.12)
  path text not null,                                  -- e.g. web/app; '.' for the whole repo
  shared_paths text[] not null default '{}',           -- shared packages it depends on, e.g. {packages/core}
  versioning text not null check (versioning in ('date', 'semver')),
  environments text[] not null default '{}',           -- deploy order, e.g. {staging,prod}; {} for a CLI
  created_at timestamptz not null default now(),
  unique (repo_id, name)
);
-- What a release ships (ST-93): its repos, and a version per app in the app's versioning.
create table release_repos (
  release_id uuid not null references tasks on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  primary key (release_id, repo_id)
);
create table release_apps (
  release_id uuid not null references tasks on delete cascade,
  app_id uuid not null references apps on delete cascade,
  version text not null,                               -- 2026.10.13 (date) or 0.1.8 (semver)
  primary key (release_id, app_id)
);
-- ST-94: a release's app deployed to one of the app's environments (checked when recorded; later edits
-- to the app's list keep the history). Written by `spider release deploy`; the first one moves a Planned
-- release to On staging, and Released needs one to each app's last environment (apps with none are exempt).
create table deployments (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  release_id uuid not null references tasks on delete cascade,
  app_id uuid not null references apps on delete cascade,
  environment text not null,                           -- e.g. staging, prod
  commit_sha text not null,                            -- 7–64 hex digits, lower-case
  actor_id uuid references actors on delete set null,  -- who recorded it
  source text not null,                                -- cli | mcp | api | ui
  created_at timestamptz not null default now()
);
create index deployments_release_idx on deployments (release_id, app_id, environment, created_at);
create index deployments_app_idx on deployments (app_id);

-- ST-84: a repo's pull requests that link to a task (others aren't kept). An event whose
-- pull_request.updated_at is older than github_updated_at is stale and changes nothing; merged is final.
create table pull_requests (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  number int not null,
  title text not null,
  state text not null check (state in ('open','closed','merged')),  -- closed: without merging
  draft boolean not null default false,
  head_branch text not null, base_branch text not null,
  author_login text,                                   -- who opened it
  merged_at timestamptz, closed_at timestamptz,
  github_updated_at timestamptz not null,              -- the PR's updated_at on GitHub
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (repo_id, number)
);
-- ST-84: branches, commits and PRs linked to tasks from webhooks; only keys of projects attached to
-- the repo count. URLs are built from the repo's current owner/name.
create table git_links (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  kind text not null check (kind in ('branch','commit','pull_request')),
  ref text not null,                                   -- branch name, full commit sha, or PR number
  pull_request_id uuid references pull_requests on delete cascade,  -- set exactly for kind pull_request
  via text not null check (via in ('closing','branch','title','body','message')),  -- strongest match
  title text, author text,                             -- commits: first message line; login or git name
  occurred_at timestamptz,                             -- commits: committed; branches: first seen
  deleted_at timestamptz,                              -- branches: deleted on GitHub (the link stays)
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (task_id, repo_id, kind, ref),
  check ((kind = 'pull_request') = (pull_request_id is not null))
);
create index git_links_repo_ref_idx on git_links (repo_id, kind, ref);
create index git_links_pull_request_idx on git_links (pull_request_id);

-- ── documents ────────────────────────────────────────
create table documents (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  project_id uuid references projects on delete cascade,
  task_id uuid references tasks on delete cascade,
  title text not null,
  format text not null check (format in ('md','html')),
  content text not null default '',
  custom_fields jsonb not null default '{}',
  author_id uuid not null references actors,
  version int not null default 1,
  updated_at timestamptz not null default now(), deleted_at timestamptz,
  check (task_id is null or project_id is not null)
);
create table document_versions (
  document_id uuid references documents on delete cascade, version int,
  content text not null, author_id uuid references actors, created_at timestamptz not null default now(),
  primary key (document_id, version)
);
-- What each document's content links to (ST-100), rebuilt on every save: [[Title]] as written
-- (matched case-insensitively), [[doc:<id>]] as kind 'document' with target 'doc:<id>' (lower-case;
-- ST-115), [[ST-12]] and plain task keys. Resolved when read, so a link may
-- name a document that doesn't exist yet; duplicate titles prefer the same project, then the
-- organization, then the newest (@repo/core/links resolveTitle).
create table document_links (
  document_id uuid not null references documents on delete cascade,
  kind text not null check (kind in ('document', 'task')),
  target text not null,
  primary key (document_id, kind, target)
);
create index document_links_target_idx on document_links (kind, lower(target));

-- ── files (objects stored in Cloudflare R2) ──────────
create table files (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  storage_key text unique not null,            -- org/<org_id>/<file_id>/<name>
  name text not null, content_type text not null, size_bytes bigint not null,
  task_id uuid references tasks on delete set null,
  document_id uuid references documents on delete set null,
  uploaded_by uuid not null references actors,
  created_at timestamptz not null default now(), deleted_at timestamptz
);

-- ── collaboration ────────────────────────────────────
create table comments (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations,
  task_id uuid references tasks on delete cascade,          -- exactly one of task_id
  document_id uuid references documents on delete cascade,  -- and document_id (ST-118)
  parent_id uuid references comments,
  author_id uuid not null references actors,
  body text not null,
  quote text,                    -- document comments: the fragment it is about (top-level only)
  document_version int,          -- document comments: the version it was posted on
  resolved_at timestamptz, resolved_by uuid references actors,   -- a resolved thread
  run_id uuid,
  created_at timestamptz not null default now(), edited_at timestamptz, deleted_at timestamptz,
  check ((task_id is null) <> (document_id is null)),
  check (quote is null or document_id is not null)
);

create table activity (
  id bigint generated always as identity primary key,
  org_id uuid not null, actor_id uuid not null,
  entity_type text not null, entity_id uuid not null,
  action text not null,                        -- 'task.status_changed', 'pr.merged', ...
  changes jsonb,                               -- {"status": ["Todo","In Progress"]}
  source text not null,                        -- ui | api | mcp | cli | git | agent_run
  run_id uuid,
  created_at timestamptz not null default now()
);
create index on activity (entity_type, entity_id, created_at desc);

-- ── agent runs ───────────────────────────────────────
create table agent_runs (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations,
  agent_id uuid not null references agents(actor_id),
  task_id uuid references tasks,
  triggered_by uuid references actors,
  trigger text not null,                       -- assign | mention | manual | schedule
  status run_status not null default 'queued',
  session_id text,                             -- Agent SDK session, used to resume
  cost_usd numeric(10,4) not null default 0,
  input_tokens bigint not null default 0, output_tokens bigint not null default 0,
  error text,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz
);
create table agent_run_events (
  run_id uuid references agent_runs on delete cascade,
  seq int not null,
  type text not null,      -- user_message | assistant_text | tool_call | tool_result | approval_request | approval_response | status
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);
```

## Custom field values

Values are stored on the row, keyed by field definition ID:

```json
{ "0192f…a1": "opt_high", "0192f…b7": 5 }
```

Filter: `custom_fields @> '{"0192f…a1":"opt_high"}'`, which uses the GIN index.

## Revisit later

- Partition `activity` and `agent_run_events` by month once they grow large.
- Move custom field values to a typed table if sorting or range filters on them get slow.
- Add `teams`/`team_members` and `subscriptions`/`notifications` when those features are built.
