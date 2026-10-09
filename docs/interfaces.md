# Interfaces

[← Project overview](./PROJECT.md)

Anything possible in the UI is also possible through these interfaces. The web app uses the same public API.

| Interface | Purpose |
|---|---|
| **Web app** | Main UI |
| **Public API** | REST with an OpenAPI spec, generated from Zod schemas |
| **MCP server** | Native tool access for agents, served over HTTP from `backend/api` |
| **CLI** | `spider`, for people, scripts and agents |
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

### Stack
- TypeScript, built on `packages/sdk` and `packages/core`
- Commander (or oclif if a plugin system is needed); @clack/prompts for interactive prompts
- Distributed through npm and as standalone binaries (`bun build --compile`) for Homebrew and curl installs
- Tokens kept in the OS keychain, with a config-file fallback

### Authentication
- `spider login`: OAuth device flow in the browser
- `SPIDER_TOKEN` environment variable for agents and CI
- `spider org switch <org>`, plus per-repo defaults in `.spider.json`

### Commands
```bash
spider task list --mine --status in_progress
spider task view SPI-123
spider task create "Fix login redirect" --project SPI --tag bug --assign @claude-agent
spider task update SPI-123 --status review --field severity=high
spider comment SPI-123 "Root cause is the cookie domain"

spider start SPI-123      # assign to me, set In Progress, create + check out branch
spider pr                 # open a pull request linked to the current branch's task
spider done               # mark the current branch's task done

spider agent list
spider agent run @reviewer SPI-123
spider agent logs <run-id> --follow

spider doc pull SPEC-12 > spec.md
spider doc push SPEC-12 spec.md
```

### Rules that make it work for agents
1. `--json` on every command, with stable output shapes.
2. Never requires interaction: every prompt has a flag. When not attached to a terminal, it fails with a clear error instead of waiting.
3. Meaningful exit codes: `0` success, `2` validation, `3` not found, `4` permission.
4. Git awareness: it finds the task from the current branch name.
5. Compact default output, so it uses little of an agent's context window.

### Later
- Local SQLite cache for instant reads and offline use
- `spider tui`: a full-screen terminal UI (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
