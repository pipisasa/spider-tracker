# Interfaces

[← Project overview](./PROJECT.md)

Anything possible in the UI is also possible through these interfaces. The web app uses the same public API.

| Interface | Purpose |
|---|---|
| **Web app** | Main UI |
| **Public API** | REST with an OpenAPI 3.1 spec at `GET /openapi.json`, request bodies generated from the Zod schemas; browsable at `/swagger` (Swagger UI) and `/scalar` (Scalar) |
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

- Base path `/v1`; organization-scoped routes under `/v1/orgs/{orgSlug}` (members, projects, tasks). The spec at `/openapi.json` is the reference; `/swagger` (Swagger UI) and `/scalar` (Scalar) render it interactively (`backend/api/src/api-docs.ts`, pinned jsDelivr builds with SRI hashes).
- Errors are `{ "error": { "code", "message" } }` with status 400 / 401 / 403 / 404 / 409.
- **Minimum CLI version:** `/v1/*` and `/mcp` responses carry `X-Spider-Min-Cli: <version>` (`MIN_CLI_VERSION` in `@repo/core`), the oldest `spider` CLI the server supports; `GET /health` returns it as `minCliVersion`. Older CLIs warn once per run (on stderr) and suggest `spider update`.
- **Activity source:** browser sessions record `source = ui`. API-key clients record `api` by default and may declare `X-Spider-Source: cli | mcp | api`; other values are ignored.

### Projects
- `GET|POST /v1/orgs/:org/projects[?archived=true]` — active projects, oldest first (archived ones too with `archived=true`); `{ key, name, description? }` to create one with the default statuses (owners and admins).
- `GET|PATCH /v1/orgs/:org/projects/:key` — a project with its statuses and `archivedAt` (archived ones too); `PATCH { name?, description? }` (owners and admins; the key can't change, `description: null` clears it).
- `POST|DELETE /v1/orgs/:org/projects/:key/archive` — archive (left out of lists, new tasks get `400 "Project ST is archived"`; its tasks stay readable and editable) or restore (owners and admins). Both return the project; repeating one changes nothing.
- Agents are created as members, so their keys (CLI, MCP) get `403` on these writes unless the agent's role is raised to admin.

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

Or install the `spider-tracker` Claude Code plugin (`spider setup claude`): it registers the server with `headersHelper: spider mcp-headers --server prod`, which prints the `Authorization` header from `SPIDER_TOKEN` or a saved agent when that key is for prod (else `{}`), and its `tasks` skill describes the workflow; see [agents.md](./agents.md#the-spider-tracker-plugin).

| Tool | What it does |
|---|---|
| `whoami` | The agent and organization the key acts as |
| `list_projects`, `get_project` | Active projects; a project's description, `archived` flag and statuses in board order, with categories |
| `create_project`, `update_project` | Owners and admins: key (fixed once created), name, description (null on update clears it) |
| `archive_project` | Owners and admins: archive a project (out of `list_projects`, no new tasks); `undo: true` restores it |
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

- **Servers** have names: `prod` (`https://tracker-api.batele.plus`, web `https://tracker.batele.plus`) and `local` (`http://localhost:4000`, web `http://localhost:5173`) are built in; other API URLs are named after their host. `--server <name|url>` picks one for `login` and `accept-invite` (else `SPIDER_API_URL`, else `prod`) and limits `mcp-headers` to that server's key.
- **Agent references:** `handle` (when unique), `org/handle` or `server/org/handle`; an ambiguous or unknown one is a usage error listing the saved agents.
- **Which key a command uses:** `--as <agent>` (any command, before or after it) > `SPIDER_TOKEN` (with `SPIDER_API_URL`) > `SPIDER_AGENT=<agent>` > the default agent (the one marked default, else the only one saved).
- The single-key file from before (`{ apiUrl, token, actor, organization }`) is read as a `login` agent and rewritten in this shape on the next save.
- A missing file means no saved agents. A file that can't be read, isn't valid JSON, has an unknown `version` or doesn't match this shape is an error (exit `1`, naming the file, never printing keys) and is never overwritten: fix it or move it away.

### Accepting an agent invite
`spider accept-invite <code|link> [--name …] [--handle …] [--description …] [--prompt …] [--no-claude] [--server …] [--default]` calls `POST /v1/agent-invites/accept` (no key needed), saves the agent under its server and organization, and makes it the default if there was none (or with `--default`). A link's host (the web app, e.g. `https://tracker.batele.plus/agent-invite/ABCD-EFGH`) picks the matching server; a link to a server the CLI doesn't know is a usage error (exit `2`) asking for `--server`. Unless `--no-claude`, it writes the agent's Claude Code agent into the private `spider-agents` plugin, with `--prompt` as its role (default: from name and description), and makes sure Claude Code has that plugin installed ([agents.md](./agents.md#claude-code-agents-the-private-spider-agents-plugin)); without `claude` on PATH it writes the file and prints how to install Claude Code. It prints who the agent is, its projects and what to run next; `--json` prints `{ agent: "server/org/handle", actor, organization, projects, owner, claudeAgent }` with `claudeAgent: { plugin: "spider-agents", name, path, qualifiedName }` (`null` with `--no-claude`), notes on stderr. The key itself is never printed. A taken handle exits `2` (`conflict`) and leaves the code usable.

### Setting up Claude Code
`spider setup claude [--json]` runs `claude plugin marketplace add pipisasa/spider-tracker`, `claude plugin install spider-tracker@spider-tracker --scope user`, then the same for the private agents plugin (`<config dir>/claude-plugin`, `spider-agents@spider-local`). All are idempotent. `SPIDER_PLUGIN_MARKETPLACE` overrides the shared marketplace source (a path — resolved against the working directory —, git URL or GitHub `owner/repo`). Without `claude` on PATH it prints how to install Claude Code and exits `0` (`--json`: `claude: false`), so install scripts can call it; a failing `claude` command exits `1`. `--json` prints `{ scope: "user", claude, marketplace, plugin, agentsPlugin }`.

`spider setup claude --project` doesn't call `claude`: it adds `extraKnownMarketplaces["spider-tracker"]` (`github`, `git` or `directory` source) and `enabledPlugins["spider-tracker@spider-tracker"]: true` to `./.claude/settings.json`, keeping everything else, so a team gets the plugin offered when they trust the project.

### Updates
`spider update [--check] [--hook] [--json]` (see [agents.md](./agents.md#updating)) checks the latest `cli-v*` GitHub release (`api.github.com/repos/pipisasa/spider-tracker/releases/latest`, else the newest `cli-v*` in the list) and the shared plugin's `plugin.json` on `main`, caching `{ checkedAt, cli, plugin }` in `<config dir>/update-check.json` (0600) for 24 hours.

- `--check` re-checks (ignoring the cache) and reports the CLI (current, latest), the installed `spider-tracker@spider-tracker` (from `claude plugin list --json`, else `~/.claude/plugins/installed_plugins.json`) and each Spider agent file's state (`current`, `outdated`, `newer`, `unmanaged`). Exit `0`. `--json`: `{ checkedAt, cli: { current, latest, outdated }, plugin: { id, installed, latest, outdated }, agents: [{ path, agent, state, version }] }`.
- `--hook` is for a Claude Code SessionStart hook: uses a fresh cache (else re-checks with a 2 s timeout), reads the plugin version from the file, never fails, prints nothing when everything is current and otherwise `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Spider Tracker: … Tell the user and offer to run `spider update` …"}}`.
- Without flags it updates the binary (compiled only), the plugin (through `claude`) and the agent files, prints one line per part and exits `1` only if a step failed. `--json`: `{ cli: { from, to, updated, note }, plugin: { id, from, to, updated, note }, agents: { refreshed, unmanaged }, restart }`.

**Passive notice:** when stderr is a terminal, after any command except `--json` runs, `mcp-headers`, `channel` and `update` (and before `spider claude` starts Claude Code), the CLI prints `A new spider is available: <current> → <latest>. Run: spider update` from the cache. A stale cache is refreshed in the background while the command runs; the CLI waits at most 300 ms more for it after the command. `SPIDER_NO_UPDATE_CHECK=1` or `CI` turns this off.

### Uninstalling

`spider uninstall [--yes] [--keep-keys] [--json]` removes everything the CLI put on the machine, in this order: revokes every saved agent's key on its server (`DELETE /v1/api-keys/current`; `--keep-keys` only forgets them), runs `claude plugin uninstall … --scope user` for `spider-tracker@spider-tracker` and `spider-agents@spider-local` and `claude plugin marketplace remove` for `spider-tracker` and `spider-local`, deletes the copies Claude Code leaves in `~/.claude/plugins/cache/{spider-tracker,spider-local}` and any other agent file with `spider-agent:` (older `~/.claude/agents` setups), then the config folder and, for a compiled install, the binary itself. Without `--yes` it shows the plan and asks (at a terminal) or exits 2 (otherwise). A key that can't be revoked is reported (exit 1) and everything else still goes. The agents stay in the tracker; delete them in Settings → Agents. It never touches other plugins or agent files.

### Starting Claude Code as an agent
`spider claude [agent] [--no-channel] [-- claude args…]` picks the agent (the argument, `--as`, a picker grouped server → organization when run at a terminal with several agents saved, else `SPIDER_AGENT` or the default) and runs:

```bash
claude [claude args…] [--agent <qualified name>] --mcp-config <tmp>/mcp.json \
  --dangerously-load-development-channels server:spider-channel
```

with `SPIDER_AGENT=<server/org/handle>` set and `SPIDER_TOKEN` removed. The temporary MCP config (0600, deleted when Claude exits) holds no secret: the `spider` HTTP server at `<server>/mcp` with `headersHelper` `<this CLI> mcp-headers --as <agent> --server <server>`, and the `spider-channel` stdio server (`<this CLI> channel --as <agent>`), where `<this CLI>` is `bun <checkout>/backend/cli/src/index.ts` from source or the compiled `spider` binary. `--agent` is added when an agent file in the private plugin (`spider-agents:<server>:<org>:<name>`) or, from older versions, anywhere under `~/.claude/agents/` says `spider-agent: <agent>` in its frontmatter, or a top-level `~/.claude/agents/<handle>.md` has no `spider-agent`. The plugin's own `spider` MCP server is namespaced `plugin:spider-tracker:spider`, so it doesn't clash with the one in the temporary config. `spider agents remove <agent> --claude` deletes the linked agent files (plugin and `~/.claude/agents`) and the folders they leave empty; without it, they are listed and kept. The exit code is Claude's.

### Login (device flow, RFC 8628)
1. `spider login [--name MacBook] [--no-browser]` calls `POST /device/code` and prints `https://tracker.batele.plus/device` with a short code (instructions on stderr), opening the browser at a terminal.
2. The person signs in, checks the code, picks the organization and approves (`/device` page → `POST /v1/device/:code/approve`, or `/deny`).
3. The CLI polls `POST /device/token` (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`) and receives an API key for a device agent, **"spider CLI · MacBook"** (`@cli-macbook`), owned by the approver and reused on later logins from the same device name. It acts with at most the approver's role.
4. The key is saved as a [saved agent](#saved-agents) (server from `--server` / `SPIDER_API_URL`, the approved organization, the device agent's handle), which becomes the default.

`spider logout` revokes the key of the saved agent in use (`--as`, `SPIDER_AGENT` or the default) on the server (`DELETE /v1/api-keys/current`) and forgets it. Device codes expire after 10 minutes and are single-use; only a hash of the device code is stored, and the key is minted at the moment the approved device collects it.

### Commands (v1)
```bash
spider login [--name …] [--no-browser] [--server prod|local|URL]
spider accept-invite <code|link> [--name …] [--handle …] [--description …] [--prompt …] [--no-claude] [--server …] [--default]
spider setup claude [--project]     # install the spider-tracker plugin (user scope) or enable it in ./.claude/settings.json
spider update [--check] [--hook]    # update the CLI, the spider-tracker plugin and agent files; --check only reports
spider logout
spider agents [list]                # saved agents by server and organization; * marks the default
spider agents default <agent>
spider agents remove <agent> [--revoke] [--claude]   # local only unless --revoke; --claude deletes its Claude Code agent
spider claude [agent] [--no-channel] [-- claude args…]
spider mcp-headers [--server prod]  # {"Authorization": "Bearer …"} for Claude Code's headersHelper; with --server, {} unless the key is that server's
spider whoami                       # also names the saved agent in use
spider <command> --as <agent>       # any command, as a saved agent
spider projects [--archived]
spider project create --key OPS --name "Operations" [--description …]   # owners and admins (also update/archive)
spider project view <KEY>                      # statuses with task counts, description, archived state
spider project update <KEY> [--name …] [--description …]   # the key can't change; --description "" clears it
spider project archive <KEY> [--undo]          # archived: out of `spider projects`, no new tasks
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
spider doc edit <id> --base-version 2 [--title …] [--format …] [--file … | --file -]   # or --force
spider channel              # Claude Code channel over stdio (see agents.md)
```

- **Task key from git:** an omitted key is taken from the current branch name (`st-12-fix`, `feat/ST-12` → `ST-12`).
- **Statuses** match by name, then by category (`in_progress`), case-insensitively. **Assignees** are handles (with or without `@`) or `me`; `--assign` is repeatable or comma-separated and replaces the list on `update`. **Priority:** `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. `--description ""` clears it.
- **Output:** one compact line per task by default. `--json` (every command) prints one line of JSON: `whoami` → `{ actor, organization, agent }` (`agent`: the saved agent's `server/org/handle`, or null for `SPIDER_TOKEN`); `agents` → `{ default, items }`; `projects` → `{ items: Project[] }`; `project create|update|archive` → the project with its `statuses`, `project view` → the same with `taskCount` on each status; `task list` → `{ items: Task[] }`; other task commands → `Task`, where `Task` is the API task plus `status: { id, name, category }` and `assignees` (handles).
- **Errors** go to stderr (`spider: …`, or `{ "error": { "code", "message" } }` with `--json`). **Exit codes:** `0` ok, `1` unexpected, `2` usage/validation, `3` not found, `4` auth/permission (not signed in, denied or expired login). `run` never prompts; only the bin passes the `spider claude` picker, and only when stdin and stdout are terminals.
- **Documents:** `--file -` reads standard input; `.html` files default to `--format html`. `doc edit` needs `--base-version <n>`, the version the edit is based on (printed by `doc view` and `doc list`): if someone saved a newer version, it fails with exit code `2` (`conflict`) instead of overwriting it. `--force` instead saves on top of whatever is current.
- Code: `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd?, openUrl?, sleep?, stdin?, select?, spawn?, self? })`; `src/index.ts` is the bin. Tests call `run` against the Hono app through `fetch`.

### Planned
- Keys in the OS keychain instead of a file, per-repo defaults in `.spider.json`
- `spider pr`, `spider start` creating and checking out the branch
- `spider agent list|run|logs`, `spider doc pull|push` (sync with local files), `--field` / `--tag`
- Distribution through npm and standalone binaries for Homebrew and curl installs
- Local SQLite cache for instant reads and offline use; `spider tui` (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
