# Interfaces

[← Project overview](./PROJECT.md)

Anything possible in the UI is also possible through these interfaces. The web app uses the same public API.

| Interface | Purpose |
|---|---|
| **Web app** | Main UI |
| **Public API** | REST with an OpenAPI 3.1 spec at `GET /openapi.json`, request bodies generated from the Zod schemas |
| **SDK** | `packages/sdk`: typed TypeScript client used by the CLI and external agents |
| **MCP server** | Native tool access for agents, served over HTTP from `backend/api` |
| **CLI** | `spider` (`backend/cli`), for people, scripts and agents |
| **Webhooks** | Outbound events: tasks, comments, runs, git links |
| **GitHub App** | Inbound repository events; outbound branch and pull request actions |

## Authentication

See [auth.md](./auth.md) for all flows.

- **People:** session cookie in the browser; `spider login` (device flow) gives the CLI an agent key for that device.
- **MCP clients:** an agent API key sent as `Authorization: Bearer spt_…` (OAuth 2.1, each connected client becoming its own agent actor, is planned).
- **Agents, CI and integrations:** API keys, stored only as hashes, scoped and revocable.

## Public API

- Base path `/v1`; organization-scoped routes under `/v1/orgs/{orgSlug}` (members, projects, tasks). The spec at `/openapi.json` is the reference.
- Errors are `{ "error": { "code", "message" } }` with status 400 / 401 / 403 / 404 / 409.
- **Activity source:** browser sessions record `source = ui`. API-key clients record `api` by default and may declare `X-Spider-Source: cli | mcp | api`; other values are ignored.

### Comments and inbox
- `GET|POST /v1/orgs/:org/tasks/:key/comments` — comments, oldest first; `{ body, parentId? }` to add.
- `GET /v1/orgs/:org/inbox?after=&unread=true&limit=&wait=` — the caller's notifications, oldest first. With `wait` (seconds, max 25) the request is held until an item newer than `after` arrives (checked every second until realtime, ST-13, replaces it).
- `POST /v1/orgs/:org/inbox/read` — `{ ids }` or `{ upTo }`.

## SDK

```ts
import { createClient, SpiderApiError } from "@repo/sdk";

const spider = createClient({ baseUrl: "https://tracker-api.batele.plus", token: process.env.SPIDER_TOKEN, source: "cli" });
const task = await spider.tasks.create("batele", "ST", { title: "Write the CLI" });
await spider.tasks.update("batele", task.key, { priority: 2 });
```

Without a token the client sends the browser session cookie (`credentials: "include"`). Non-2xx responses throw `SpiderApiError(status, code, message)`; `204` resolves to `undefined`.

## MCP server

Streamable HTTP at `POST /mcp` (`backend/api/src/mcp.ts`), stateless: no session ids, every request gets a fresh server. It accepts only an agent API key (`Authorization: Bearer spt_…`); anything else gets `401` with `WWW-Authenticate: Bearer`. The agent acts in its key's organization, and every action records `source = mcp`.

Connect Claude Code:

```bash
claude mcp add --transport http spider https://tracker-api.batele.plus/mcp --header "Authorization: Bearer $SPIDER_TOKEN"
```

Inside this repository, the project `.mcp.json` already registers it: its `headersHelper` runs `spider mcp-headers`, which prints the `Authorization` header from `SPIDER_TOKEN` or the key saved by `spider login`, and the `spider-tracker` skill in `.claude/skills` describes the workflow; see [agents.md](./agents.md#distribution).

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
| `list_tags`, `create_tag` | Organization tags; `create_task` / `update_task` take `tags` by name (update replaces the list) |
| `list_comments`, `add_comment` | A task's comments; comment with `@handle` mentions, `parent_id` to reply |
| `get_inbox` | Your notifications (mention, assigned, comment, reply), oldest first; `after` cursor, `unread_only` (default true), `wait_seconds` (≤ 20) |
| `mark_inbox_read` | By `ids` or `up_to` an id |

Status names and handles match case-insensitively; an unknown one returns a tool error listing the valid options. Domain errors (not found, forbidden, validation) come back as tool errors (`isError`) with their message.

Planned: documents, custom fields.

## CLI

`backend/cli` (`@repo/cli`): the `spider` command, built on `packages/sdk` with Commander. Every action records `source = cli`.

```bash
spider login                              # sign in through the browser (device flow); saves a key for this device
export SPIDER_TOKEN=spt_…                 # or: an agent API key, which overrides the saved one (CI, agents)
export SPIDER_API_URL=https://…           # optional, default https://tracker-api.batele.plus
bun run spider task list --mine           # from the repo; `bun link` in backend/cli installs `spider`; or build dist/spider
```

The organization is the key's (from `whoami`).

### Login (device flow, RFC 8628)
1. `spider login [--name MacBook] [--no-browser]` calls `POST /device/code` and prints `https://tracker.batele.plus/device` with a short code (instructions on stderr), opening the browser at a terminal.
2. The person signs in, checks the code, picks the organization and approves (`/device` page → `POST /v1/device/:code/approve`, or `/deny`).
3. The CLI polls `POST /device/token` (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`) and receives an API key for a device agent, **"spider CLI · MacBook"** (`@cli-macbook`), owned by the approver and reused on later logins from the same device name. It acts with at most the approver's role.
4. The key is saved to `~/.config/spider-tracker/credentials.json` (mode 0600; `SPIDER_CONFIG_DIR` overrides the folder).

`spider logout` revokes that key on the server (`DELETE /v1/api-keys/current`) and deletes the file. Device codes expire after 10 minutes and are single-use; only a hash of the device code is stored, and the key is minted at the moment the approved device collects it.

### Commands (v1)
```bash
spider login [--name …] [--no-browser]
spider logout
spider whoami
spider projects
spider task list [--project ST] [--status "In Progress"] [--mine] [--limit 50]
spider task view [ST-12]
spider task create --project ST --title "Fix login" [--description …] [--status Todo] [--priority 0-4] [--assign @alice --assign me]
spider task update [ST-12] [--title …] [--description …] [--status …] [--priority …] [--assign …]
spider task start [ST-12]   # assign me + the project's first in-progress status
spider task done [ST-12]    # the project's first done status
spider tags
spider task create … [--tag bug --tag agent]   # also on update (replaces; --tag "" clears)
spider comment [ST-12] "text with @mentions"
spider comments [ST-12]
spider inbox [--all] [--wait 25] [--mark-read]
spider channel              # Claude Code channel over stdio (see agents.md)
```

- **Task key from git:** an omitted key is taken from the current branch name (`st-12-fix`, `feat/ST-12` → `ST-12`).
- **Statuses** match by name, then by category (`in_progress`), case-insensitively. **Assignees** are handles (with or without `@`) or `me`; `--assign` is repeatable or comma-separated and replaces the list on `update`. **Priority:** `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. `--description ""` clears it.
- **Output:** one compact line per task by default. `--json` (every command) prints one line of JSON: `whoami` → `{ actor, organization }`; `projects` → `{ items: Project[] }`; `task list` → `{ items: Task[] }`; other task commands → `Task`, where `Task` is the API task plus `status: { id, name, category }` and `assignees` (handles).
- **Errors** go to stderr (`spider: …`, or `{ "error": { "code", "message" } }` with `--json`). **Exit codes:** `0` ok, `1` unexpected, `2` usage/validation, `3` not found, `4` auth/permission (not signed in, denied or expired login). It never prompts.
- Code: `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd?, openUrl?, sleep? })`; `src/index.ts` is the bin. Tests call `run` against the Hono app through `fetch`.

### Planned
- Keys in the OS keychain instead of a file, `spider org switch`, per-repo defaults in `.spider.json`
- `spider pr`, `spider start` creating and checking out the branch
- `spider agent list|run|logs`, `spider doc pull|push`, `--field` / `--tag`
- Distribution through npm and standalone binaries for Homebrew and curl installs
- Local SQLite cache for instant reads and offline use; `spider tui` (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
