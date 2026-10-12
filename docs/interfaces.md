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
- `GET|POST /v1/orgs/:org/documents[?project=ST|?task=ST-12]` — documents without content, most recently updated first (a project's include its tasks'; no filter lists the whole organization); `{ title, format?: md|html, content?, project?, task? }` to create (a task implies its project; neither means organization-wide). Content is capped at 1 MB.
- `GET|PATCH|DELETE /v1/orgs/:org/documents/:id` — `PATCH { baseVersion, title?, format?, content? }` saves a new version; `409 conflict` if someone saved since `baseVersion`, and an unchanged save returns the document as is.
- `GET /v1/orgs/:org/documents/:id/versions[/:version]` — every save is a version (newest first, without content), or one version with its content.

### Members and invitations
- `GET /v1/orgs/:org/members` — people and agents with their roles.
- `GET|POST /v1/orgs/:org/invitations` — owners and admins: active codes plus ones expired or revoked in the last 7 days; `{ role?: admin|member|guest, expiresInDays?: 1–30 (7), maxUses?: 1–1000 }` to create (only owners invite admins). Codes are 8 characters from an unambiguous alphabet, shown as `ABCD-EFGH`; input ignores case, dashes and spaces.
- `DELETE /v1/orgs/:org/invitations/:id` — revoke a code.
- `POST /v1/invitations/preview` `{ code }` — the organization and role a code joins, and whether you're already a member.
- `POST /v1/invitations/accept` `{ code }` → `201` membership. Browser sessions only (API keys get `403`); `409` if already a member. Unknown, expired, revoked and used-up codes all get the same `400 "Invalid or expired invitation code"`.
- `GET|POST /v1/orgs/:org/agents` — active agents with `owner { id, name, handle }`, `canManage`, and key metadata only for agents you can manage; `{ name, handle?, description? }` to create one owned by you (owners, admins and members; guests and agent keys get `403`).
- `PATCH|DELETE /v1/orgs/:org/agents/:agentId` — the agent's owner or an owner/admin: `{ name?, handle?, description? }` (`409` if the handle is taken); `DELETE` deactivates the agent and revokes all its keys (`204`).
- `POST /v1/orgs/:org/agents/:agentId/keys` `{ name }` → `201 { key, secret }`, the secret shown once; `DELETE /v1/orgs/:org/api-keys/:keyId` revokes one. Same permission as above.
- `PATCH /v1/orgs/:org/agents/me` `{ name?, handle?, description? }` → `200` agent — an agent key updating itself (an agent may also `PATCH` its own `/agents/:agentId`). Agents carry `projects: [{ key, name }] | null` (null = all projects).

### Agent invites
- `GET|POST /v1/orgs/:org/agent-invites` — people who can create agents. `POST { projectKeys: string[] (≥ 1), expiresInDays?: 1–30 (7) }` → `201 { invite, agent }`: creates a pending agent owned by you, limited to those projects, and a one-time code (`ABCD-EFGH`). `GET` lists unused invites for agents you can manage (`status: pending | expired`; expired ones for 7 days).
- `DELETE /v1/orgs/:org/agent-invites/:id` — revoke an unused invite; its pending agent is removed.
- `POST /v1/agent-invites/accept` `{ code, name?, handle?, description? }` → `201 { token, actor, organization: { id, slug, name }, projects: [{ key, name }], owner: { id, name, handle } }`. **No session or key**: the code is the credential. `code` may be the invite link (`…/agent-invite/ABCD-EFGH` or `…?code=…`). Activates the agent, applies the optional fields (`409` on a taken handle, without using up the code; a name without a handle derives one) and returns its first API key (named `invite`), shown once. Unknown, used, revoked and expired codes get `400 "Invalid or expired invitation code"`. Best-effort limit of 10 attempts per minute per client IP (`cf-connecting-ip`, else `x-forwarded-for`), per API instance → `429`.
- The web shows the link as `${WEB_ORIGIN}/agent-invite/<CODE>`, a public page with the commands `spider accept-invite <CODE>` and `/spider-tracker:create-agent <CODE>`.

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
| `get_task` | One task by key, with status name, assignee handles, tags, parent and sub-tasks |
| `create_task`, `update_task` | Status by name, priority 0–4, assignees as handles or `me`, `parent` as a task key (null on update makes it top-level); `update_task` replaces the assignee list |
| `assign_to_me` | Adds the agent to a task's assignees |
| `start_task` | Assigns the agent and moves the task to the project's first in-progress status |
| `list_members` | People and agents with their handles |
| `link_tasks`, `unlink_tasks` | Links between tasks: `blocks` / `blocked_by`, `relates`, `duplicates` / `duplicated_by` (from this task's side); `get_task` lists them |
| `list_tags`, `create_tag` | Organization tags; `create_task` / `update_task` take `tags` by name (update replaces the list) |
| `list_comments`, `add_comment` | A task's comments; comment with `@handle` mentions, `parent_id` to reply |
| `get_inbox` | Your notifications (mention, assigned, comment, reply), oldest first; `after` cursor, `unread_only` (default true), `wait_seconds` (≤ 20) |
| `mark_inbox_read` | By `ids` or `up_to` an id |
| `list_documents` | Documents (no content) of a `task`, a `project` (with its tasks') or the whole organization; `get_project` and `get_task` also list theirs |
| `get_document` | Content and `version` (the `baseVersion` for updates); `version` argument reads an older one |
| `create_document`, `update_document` | Markdown or HTML, organization-wide or in a `project` / `task`; `update_document` needs `baseVersion` and fails if someone saved since |

Status names and handles match case-insensitively; an unknown one returns a tool error listing the valid options. Domain errors (not found, forbidden, validation) come back as tool errors (`isError`) with their message.

Planned: custom fields.

## CLI

`backend/cli` (`@repo/cli`): the `spider` command, built on `packages/sdk` with Commander. Every action records `source = cli`.

```bash
spider accept-invite ABCD-EFGH --name Reviewer   # set up an invited agent; saves its key on this machine
spider login                              # or: sign in through the browser (device flow); saves a device agent
export SPIDER_TOKEN=spt_…                 # or: an agent API key, which overrides the default saved agent (CI)
export SPIDER_API_URL=https://…           # optional, default https://tracker-api.batele.plus
bun run spider task list --mine           # from the repo; `bun link` in backend/cli installs `spider`; or build dist/spider
```

The organization is the key's (from `whoami`).

### Saved agents
`~/.config/spider-tracker/credentials.json` (mode 0600 in a 0700 folder; `SPIDER_CONFIG_DIR` overrides the folder) holds any number of agent keys, nested server → organization → agent handle:

```json
{
  "version": 2,
  "default": { "server": "prod", "org": "batele", "agent": "reviewer" },
  "servers": {
    "prod": {
      "name": "Prod tracker", "url": "https://tracker-api.batele.plus", "webUrl": "https://tracker.batele.plus",
      "orgs": {
        "batele": {
          "name": "Batele",
          "agents": {
            "reviewer": { "token": "spt_…", "actor": { "id": "…", "name": "Reviewer", "handle": "reviewer" },
                          "projects": [{ "key": "ST", "name": "Spider Tracker" }], "source": "invite", "createdAt": "…" }
          }
        }
      }
    }
  }
}
```

- **Servers** have names: `prod` (`https://tracker-api.batele.plus`, web `https://tracker.batele.plus`) and `local` (`http://localhost:4000`, web `http://localhost:5173`) are built in; other API URLs are named after their host. `--server <name|url>` picks one for `login` and `accept-invite` (else `SPIDER_API_URL`, else `prod`).
- **Agent references:** `handle` (when unique), `org/handle` or `server/org/handle`; an ambiguous or unknown one is a usage error listing the saved agents.
- **Which key a command uses:** `--as <agent>` (any command, before or after it) > `SPIDER_TOKEN` (with `SPIDER_API_URL`) > `SPIDER_AGENT=<agent>` > the default agent (the one marked default, else the only one saved).
- The single-key file from before (`{ apiUrl, token, actor, organization }`) is read as a `login` agent and rewritten in this shape on the next save.

### Accepting an agent invite
`spider accept-invite <code|link> [--name …] [--handle …] [--description …] [--server …] [--default]` calls `POST /v1/agent-invites/accept` (no key needed), saves the agent under its server and organization, and makes it the default if there was none (or with `--default`). A link's host (the web app, e.g. `https://tracker.batele.plus/agent-invite/ABCD-EFGH`) picks the matching server. It prints who the agent is, its projects and what to run next; `--json` prints `{ agent: "server/org/handle", actor, organization, projects, owner }`. The key itself is never printed. A taken handle exits `2` (`conflict`) and leaves the code usable.

### Starting Claude Code as an agent
`spider claude [agent] [--no-channel] [-- claude args…]` picks the agent (the argument, `--as`, a picker grouped server → organization when run at a terminal with several agents saved, else `SPIDER_AGENT` or the default) and runs:

```bash
claude [claude args…] [--agent <name>] --mcp-config <tmp>/mcp.json \
  --dangerously-load-development-channels server:spider-channel
```

with `SPIDER_AGENT=<server/org/handle>` set and `SPIDER_TOKEN` removed. The temporary MCP config (0600, deleted when Claude exits) holds no secret: the `spider` HTTP server at `<server>/mcp` with `headersHelper` `<this CLI> mcp-headers --as <agent>`, and the `spider-channel` stdio server (`<this CLI> channel --as <agent>`), where `<this CLI>` is `bun <checkout>/backend/cli/src/index.ts` from source or the compiled `spider` binary. `--agent` is added when an agent file anywhere under `~/.claude/agents/` (subfolders included) says `spider-agent: <agent>` in its frontmatter, or a top-level `<handle>.md` has no `spider-agent`. `spider accept-invite --json` also returns `claudeAgent: { path, name }`: where that agent's file goes (`~/.claude/agents/spider/<server>/<org>/<handle>.md`) and a `name` no other agent file uses. `spider agents remove <agent> --claude` deletes the linked agent files and empty `spider/` folders; without it, they are listed and kept. The exit code is Claude's.

### Login (device flow, RFC 8628)
1. `spider login [--name MacBook] [--no-browser]` calls `POST /device/code` and prints `https://tracker.batele.plus/device` with a short code (instructions on stderr), opening the browser at a terminal.
2. The person signs in, checks the code, picks the organization and approves (`/device` page → `POST /v1/device/:code/approve`, or `/deny`).
3. The CLI polls `POST /device/token` (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`) and receives an API key for a device agent, **"spider CLI · MacBook"** (`@cli-macbook`), owned by the approver and reused on later logins from the same device name. It acts with at most the approver's role.
4. The key is saved as a [saved agent](#saved-agents) (server from `--server` / `SPIDER_API_URL`, the approved organization, the device agent's handle), which becomes the default.

`spider logout` revokes the key of the saved agent in use (`--as`, `SPIDER_AGENT` or the default) on the server (`DELETE /v1/api-keys/current`) and forgets it. Device codes expire after 10 minutes and are single-use; only a hash of the device code is stored, and the key is minted at the moment the approved device collects it.

### Commands (v1)
```bash
spider login [--name …] [--no-browser] [--server prod|local|URL]
spider accept-invite <code|link> [--name …] [--handle …] [--description …] [--server …] [--default]
spider logout
spider agents [list]                # saved agents by server and organization; * marks the default
spider agents default <agent>
spider agents remove <agent> [--revoke]   # local only unless --revoke (revokes the key on the server)
spider claude [agent] [--no-channel] [-- claude args…]
spider mcp-headers                  # {"Authorization": "Bearer …"} for Claude Code's headersHelper
spider whoami                       # also names the saved agent in use
spider <command> --as <agent>       # any command, as a saved agent
spider projects
spider task list [--project ST] [--status "In Progress"] [--mine] [--limit 50]
spider task view [ST-12]
spider task create --project ST --title "Fix login" [--description …] [--status Todo] [--priority 0-4] [--assign @alice --assign me]
spider task update [ST-12] [--title …] [--description …] [--status …] [--priority …] [--assign …]
spider task start [ST-12]   # assign me + the project's first in-progress status
spider task done [ST-12]    # the project's first done status
spider tags
spider task create … [--tag bug --tag agent]   # also on update (replaces; --tag "" clears)
spider link ST-1 blocks ST-2                     # blocked-by, relates, duplicates, duplicated-by; `spider unlink` removes
spider task create … --parent ST-3              # a sub-task; on update --parent "" makes it top-level
spider comment [ST-12] "text with @mentions"
spider comments [ST-12]
spider inbox [--all] [--wait 25] [--mark-read]
spider doc list [--project ST] [--task ST-12]
spider doc view <id> [--rev 3]                 # --rev: an older version
spider doc create --title … [--project ST | --task ST-12] [--format md|html] [--file spec.md | --file -]
spider doc edit <id> [--title …] [--format …] [--file … | --file -]   # saves on top of the current version
spider channel              # Claude Code channel over stdio (see agents.md)
```

- **Task key from git:** an omitted key is taken from the current branch name (`st-12-fix`, `feat/ST-12` → `ST-12`).
- **Statuses** match by name, then by category (`in_progress`), case-insensitively. **Assignees** are handles (with or without `@`) or `me`; `--assign` is repeatable or comma-separated and replaces the list on `update`. **Priority:** `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. `--description ""` clears it.
- **Output:** one compact line per task by default. `--json` (every command) prints one line of JSON: `whoami` → `{ actor, organization, agent }` (`agent`: the saved agent's `server/org/handle`, or null for `SPIDER_TOKEN`); `agents` → `{ default, items }`; `projects` → `{ items: Project[] }`; `task list` → `{ items: Task[] }`; other task commands → `Task`, where `Task` is the API task plus `status: { id, name, category }` and `assignees` (handles).
- **Errors** go to stderr (`spider: …`, or `{ "error": { "code", "message" } }` with `--json`). **Exit codes:** `0` ok, `1` unexpected, `2` usage/validation, `3` not found, `4` auth/permission (not signed in, denied or expired login). `run` never prompts; only the bin passes the `spider claude` picker, and only when stdin and stdout are terminals.
- **Documents:** `--file -` reads standard input; `.html` files default to `--format html`. `doc edit` fetches the current version and sends it as `baseVersion`, so a concurrent save fails with exit code `2` instead of being overwritten.
- Code: `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd?, openUrl?, sleep?, stdin?, select?, spawn?, self? })`; `src/index.ts` is the bin. Tests call `run` against the Hono app through `fetch`.

### Planned
- Keys in the OS keychain instead of a file, per-repo defaults in `.spider.json`
- `spider pr`, `spider start` creating and checking out the branch
- `spider agent list|run|logs`, `spider doc pull|push` (sync with local files), `--field` / `--tag`
- Distribution through npm and standalone binaries for Homebrew and curl installs
- Local SQLite cache for instant reads and offline use; `spider tui` (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
