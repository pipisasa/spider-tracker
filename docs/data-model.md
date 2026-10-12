# Data model

[← Project overview](./PROJECT.md) · Database: Postgres (see [decisions.md](./decisions.md))

## Overview

Identity tables (users, sessions, OAuth clients and tokens) belong to Better Auth; see [auth.md](./auth.md#what-owns-what). The tables below are ours.

```
organizations ─┬─ actors (human | agent) ── agents (1:1 config), api_tokens
               ├─ tags, custom_field_defs, repos, apps, documents
               └─ projects ─┬─ statuses, cycles, custom_field_defs (project-scoped)
                            └─ tasks ─┬─ task_assignees → actors
                                      ├─ task_tags, task_relations, sub-tasks (parent_id)
                                      ├─ comments, documents, git_links → repos
                                      └─ agent_runs ── agent_run_events
activity (append-only log for everything)
```

## Entities

| Entity | Purpose |
|---|---|
| **Organization** | The tenant boundary; owns everything else |
| **Actor** | A member: a person or an agent |
| **Agent** | Extra configuration for agent actors (model, prompt, tools, limits) |
| **API token** | Hashed API keys for external agents and CI |
| **Project** | A unit of work with a key (`SPI`), workflow and settings |
| **Status** | A per-project workflow state, mapped to a fixed category |
| **Cycle** | A sprint or milestone |
| **Task** | A unit of work; supports sub-tasks, relations, assignees, tags and custom fields |
| **Tag** | An organization-wide label |
| **Custom field definition** | A user-defined field at organization or project scope |
| **Repo** | A linked Git/GitHub repository |
| **App** | A deployable product, linked to repos and projects |
| **Git link** | A branch, commit or pull request linked to a task |
| **Document** | Markdown or HTML content at organization, project or task level, with versions |
| **File** | Metadata for an object stored in Cloudflare R2 (attachments, images, artifacts) |
| **Comment** | A threaded Markdown comment on a task |
| **Inbox item** | A notification for one actor: mention, assignment, reply or comment on their task; its id is a cursor for waiting clients |
| **Device code** | A pending `spider login` (RFC 8628): hashed device code, user code, approver, expiry |
| **Activity** | Append-only audit log of every change |
| **Agent run** | One execution of an agent on a task |
| **Agent run event** | One streamed event from a run: messages, tool calls, approvals |

## Design decisions

| Decision | Why |
|---|---|
| One `actors` table for people and agents | Assignees, authors, mentions and the audit log all point at a single table. Agent-only settings live in `agents`. |
| `org_id` on every main table | Access control is one rule: the row's `org_id` must be in the user's organizations. It also makes per-organization filters fast. |
| UUIDv7 primary keys + per-project numbers | UUIDv7 IDs sort by creation time and keep indexes efficient. `SPI-123` comes from `projects.task_seq`, incremented in the same transaction that inserts the task. |
| Statuses belong to projects, each mapped to a fixed category | Projects name their columns freely; automation and reports use the categories. |
| Custom field values as JSON, keyed by field definition ID | Renaming a field touches no data. A GIN index keeps filtering fast. The app's `core` package validates values against the definitions. |
| `sort_key` holds a fractional index | Dragging a card changes one row instead of renumbering the column. |
| Explicit columns on `documents` (not a generic "attached to" pair) | Foreign keys and cascading deletes keep working. |
| Run events kept separate from comments | `agent_run_events` holds the full trace and chat; comments hold the clean result people read. |
| Soft delete (`deleted_at`) on tasks, documents and comments | Supports undo and keeps the audit history intact. |

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
  check ((type = 'human') = (user_id is not null))
);

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
  archived_at timestamptz,
  unique (org_id, key)
);

create table statuses (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects on delete cascade,
  name text not null, category status_category not null,
  color text, position int not null,
  unique (project_id, name)
);

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
  status_id uuid not null references statuses,
  priority smallint not null default 0 check (priority between 0 and 4),
  parent_id uuid references tasks,
  cycle_id uuid references cycles,
  estimate numeric, due_on date,
  sort_key text not null,
  custom_fields jsonb not null default '{}',
  creator_id uuid not null references actors,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz, deleted_at timestamptz,
  search tsvector generated always as
    (to_tsvector('simple', title || ' ' || coalesce(description, ''))) stored,
  unique (project_id, number)
);
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
-- viewFiltersSchema in core: { status?: id[], assignee?: (id|'me'|'none')[], priority?: 0-4[], tag?: id[], q?: text }.
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
create table repos (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  provider text not null default 'github', installation_id bigint,
  full_name text not null, default_branch text not null default 'main',
  unique (org_id, provider, full_name)
);
create table apps (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations on delete cascade,
  name text not null, description text, links jsonb not null default '{}'
);
create table app_repos     (app_id uuid references apps on delete cascade,         repo_id uuid references repos on delete cascade, primary key (app_id, repo_id));
create table project_repos (project_id uuid references projects on delete cascade, repo_id uuid references repos on delete cascade, primary key (project_id, repo_id));
create table project_apps  (project_id uuid references projects on delete cascade, app_id uuid references apps on delete cascade,   primary key (project_id, app_id));

create table git_links (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  kind text not null check (kind in ('branch','commit','pr')),
  ref text not null, url text, title text, state text,
  author_login text, metadata jsonb not null default '{}',
  unique (task_id, repo_id, kind, ref)
);

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
  task_id uuid not null references tasks on delete cascade,
  parent_id uuid references comments,
  author_id uuid not null references actors,
  body text not null,
  run_id uuid,
  created_at timestamptz not null default now(), edited_at timestamptz, deleted_at timestamptz
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
