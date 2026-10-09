# Interfaces

[← Project overview](./PROJECT.md)

Anything possible in the UI is also possible through these interfaces. The web app uses the same public API.

| Interface | Purpose |
|---|---|
| **Web app** | Main UI |
| **Public API** | REST with an OpenAPI spec, generated from Zod schemas |
| **MCP server** | Native tool access for agents, served over HTTP from `backend/api` |
| **CLI** | `spider` (`backend/cli`), for people, scripts and agents |
| **Webhooks** | Outbound events: tasks, comments, runs, git links |
| **GitHub App** | Inbound repository events; outbound branch and pull request actions |

## Authentication

See [auth.md](./auth.md) for all flows.

- **People:** session cookie in the browser; OAuth device flow for the CLI.
- **MCP clients:** an agent API key sent as `Authorization: Bearer spt_…` (OAuth 2.1, each connected client becoming its own agent actor, is planned).
- **Agents, CI and integrations:** API keys, stored only as hashes, scoped and revocable.

## MCP server

Streamable HTTP at `POST /mcp` (`backend/api/src/mcp.ts`), stateless: no session ids, every request gets a fresh server. It accepts only an agent API key (`Authorization: Bearer spt_…`); anything else gets `401` with `WWW-Authenticate: Bearer`. The agent acts in its key's organization, and every action records `source = mcp`.

Connect Claude Code:

```bash
claude mcp add --transport http spider https://tracker-api.batele.plus/mcp --header "Authorization: Bearer $SPIDER_TOKEN"
```

Inside this repository, the project `.mcp.json` already registers it (with `${SPIDER_TOKEN}` expanded from the environment), and the `spider-tracker` skill in `.claude/skills` describes the workflow; see [agents.md](./agents.md#distribution).

| Tool | What it does |
|---|---|
| `whoami` | The agent and organization the key acts as |
| `list_projects`, `get_project` | Projects; a project's statuses in board order, with categories |
| `list_tasks` | Tasks in a project; filters: `status` (name or category), `assignee` (`me` or a handle), `query` (title text), `limit` |
| `get_task` | One task by key, with status name and assignee handles |
| `create_task`, `update_task` | Status by name, priority 0–4, assignees as handles or `me`; `update_task` replaces the assignee list |
| `assign_to_me` | Adds the agent to a task's assignees |
| `start_task` | Assigns the agent and moves the task to the project's first in-progress status |
| `list_members` | People and agents with their handles |

Status names and handles match case-insensitively; an unknown one returns a tool error listing the valid options. Domain errors (not found, forbidden, validation) come back as tool errors (`isError`) with their message.

Planned: comments, documents, custom fields.

## CLI

`backend/cli` (`@repo/cli`): the `spider` command, built on `packages/sdk` with Commander. Every action records `source = cli`.

```bash
export SPIDER_TOKEN=spt_…                 # agent API key (required; never printed)
export SPIDER_API_URL=https://…           # optional, default https://tracker-api.batele.plus
bun run spider task list --mine           # from the repo; or build a binary: bun run --cwd backend/cli build → dist/spider
```

The organization is the token's (from `whoami`).

### Commands (v1)
```bash
spider whoami
spider projects
spider task list [--project ST] [--status "In Progress"] [--mine] [--limit 50]
spider task view [ST-12]
spider task create --project ST --title "Fix login" [--description …] [--status Todo] [--priority 0-4] [--assign @alice --assign me]
spider task update [ST-12] [--title …] [--description …] [--status …] [--priority …] [--assign …]
spider task start [ST-12]   # assign me + the project's first in-progress status
spider task done [ST-12]    # the project's first done status
```

- **Task key from git:** an omitted key is taken from the current branch name (`st-12-fix`, `feat/ST-12` → `ST-12`).
- **Statuses** match by name, then by category (`in_progress`), case-insensitively. **Assignees** are handles (with or without `@`) or `me`; `--assign` is repeatable or comma-separated and replaces the list on `update`. **Priority:** `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. `--description ""` clears it.
- **Output:** one compact line per task by default. `--json` (every command) prints one line of JSON: `whoami` → `{ actor, organization }`; `projects` → `{ items: Project[] }`; `task list` → `{ items: Task[] }`; other task commands → `Task`, where `Task` is the API task plus `status: { id, name, category }` and `assignees` (handles).
- **Errors** go to stderr (`spider: …`, or `{ "error": { "code", "message" } }` with `--json`). **Exit codes:** `0` ok, `1` unexpected, `2` usage/validation, `3` not found, `4` auth/permission (including a missing `SPIDER_TOKEN`). It never prompts.
- Code: `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd? })`; `src/index.ts` is the bin. Tests call `run` against the Hono app through `fetch`.

### Planned
- `spider login` (OAuth device flow), tokens in the OS keychain, `spider org switch`, per-repo defaults in `.spider.json`
- `spider comment ST-12 "…"`, `spider pr`, `spider start` creating and checking out the branch
- `spider agent list|run|logs`, `spider doc pull|push`, `--field` / `--tag`
- Distribution through npm and standalone binaries for Homebrew and curl installs
- Local SQLite cache for instant reads and offline use; `spider tui` (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
