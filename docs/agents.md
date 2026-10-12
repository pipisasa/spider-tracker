# Agents

[← Project overview](./PROJECT.md)

## Agent model

An agent is an **actor**, like a person. It has a handle, an avatar, a role and permissions, and it can be assigned tasks, mentioned, and post comments.

| Kind | Where it runs | How it connects |
|---|---|---|
| **Hosted** | Our `backend/worker` | Claude Agent SDK, configured in the app |
| **External** | Anywhere: a user's laptop, CI, another platform | API token → MCP, CLI or REST |

A hosted agent's configuration: provider/model, system prompt, allowed tools and MCP servers, repo access, allowed projects and limits.

## Who creates and manages agents

- **Create:** any person with the owner, admin or member role, in Settings → Agents or with `spider login` (which creates a `cli-…` agent on approval). Guests and agent keys can't create agents. The agent belongs to its creator and gets the member role (never more than its owner's).
- **Manage** (edit name, handle and description, issue and revoke keys, delete): the agent's owner, or an organization owner or admin (`assertCanManageAgent` in `packages/core/src/agents.ts`).
- **See:** everyone but guests sees all active agents and their owners in Settings → Agents ("My agents" and "Other agents"); keys, never their secrets, are listed only for agents you can manage.
- **Delete** deactivates the agent, like a person who leaves: its keys are revoked, it disappears from member lists and pickers, and its comments, history and assignments stay. Its handle stays reserved.
- When the owning person is deactivated, the keys of their agents stop working.
- **Self-update:** an agent may change its own name, handle and description (`PATCH /v1/orgs/:org/agents/me`), nothing else.

## Agent invites

Instead of creating an agent and pasting a key, a person can **invite** one (Settings → Agents → Invite agent): pick the projects it may see and an expiry (1, 7 or 30 days). This creates a pending agent owned by them ("New agent", handle `agent-xxxx`) and a one-time code `ABCD-EFGH`, with a link `${WEB_ORIGIN}/agent-invite/ABCD-EFGH`.

The agent accepts the code itself (`spider accept-invite ABCD-EFGH`, or `/spider-tracker:create-agent ABCD-EFGH` in Claude Code), calling `POST /v1/agent-invites/accept` without any credentials, optionally naming itself. It gets its first API key and learns its organization, projects and owner. Until then the pending agent is kept deactivated, so it never shows up as a member, assignee or mention target; Settings → Agents lists it under "Waiting for setup", where it can be revoked (which removes it). Code logic: `packages/core/src/agent-invites.ts`.

### Saved agents on a machine
The CLI keeps every agent it sets up in `~/.config/spider-tracker/credentials.json`, nested server → organization → handle ([interfaces.md](./interfaces.md#saved-agents)), so one laptop can run several agents on several trackers:

```bash
spider accept-invite ABCD-EFGH --name Reviewer   # or the invite link; saves prod/batele/reviewer
spider agents                                     # list them; * marks the default
spider task list --mine --as reviewer             # any command as a saved agent
spider claude reviewer                            # Claude Code as that agent (picker without a name)
```

`spider claude` starts `claude` with a temporary, secret-free MCP config: the `spider` MCP server (key from `spider mcp-headers --as <agent> --server <server>`) and the `spider-channel` inbox channel, plus `--agent spider-agents:<server>:<org>:<name>` for the agent's Claude Code agent (below). It sets `SPIDER_AGENT` for the session, so `spider …` commands run inside it act as the same agent.

At startup it prints, on stderr, the agent, the permission mode and anything that will interrupt the start:

- **Permission mode, always explicit.** Left to itself, Claude Code takes the mode from settings (`permissions.defaultMode`, which can differ per project) or its built-in default (auto in a terminal since 2.1.283), so agents on one machine started in different modes. `spider claude` always decides it: `spider claude <agent> --permission-mode <mode>`, else one given to claude after `--` (or `--dangerously-skip-permissions`, kept as is), else the agent's saved mode (`spider agents permission-mode <agent> <mode>`, `--clear` to unset; listed by `spider agents --json`), else `auto`. Modes: `auto`, `manual` (= `default`), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. The line reads e.g. `Permission mode: auto (spider default)`. Resumed sessions (`-- --resume …`) get it too instead of the mode they were saved in. (A `permissionMode` in the agent file wouldn't do: Claude Code ignores it for plugin agents.)
- **Development channels can't be pre-confirmed.** The inbox channel is local, not on Claude Code's channel allowlist, so it needs `--dangerously-load-development-channels`, and Claude Code shows "WARNING: Loading development channels … I am using this for local development" at every interactive start. Claude Code (checked in 2.1.296 and its docs) has no flag, user setting, env var or remembered answer for it: the dialog is skipped only without claude.ai auth or under managed (organization) settings, and the allowlist (`allowedChannelPlugins`, for plugins only) is a managed setting too. The flag is ignored with `-p`. Workarounds: press Enter once per start; for agents started unattended in tmux, send it once the dialog is up (`tmux send-keys -t '=<session>:<handle>' Enter`, or for every window of a team: `for w in $(tmux list-windows -t '=<session>' -F '#W'); do tmux send-keys -t "=<session>:$w" Enter; done`); or `spider claude <agent> --no-channel`, and the agent reads its inbox with the `get_inbox` tool. (`bypassPermissions` has its own one-time confirmation.)
- **Broken hooks.** Claude Code runs every hook in the user's and the project's settings; one whose script is gone fails at every start (a missing `node` script prints `node:internal/modules/cjs/loader … Cannot find module`, the SessionStart error seen when agents started). `spider claude` warns about each hook in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), `.claude/settings.json` and `.claude/settings.local.json` that runs a missing script by absolute path, naming the file to fix. The plugin's own SessionStart hook (`spider update --check --hook`) can't cause it: it runs only when `spider` is on PATH and ends in `|| true`.

#### A team of agents in tmux
Running many agents at once (say a project's 17 role agents) takes one command; each agent gets its own window of a tmux session, named by its handle:

```bash
spider claude --all --project ANT --tmux ant-agents --dry-run   # the plan: which windows start, which already run
spider claude --all --project ANT --tmux ant-agents             # one window per ANT agent
spider claude ant-owner ant-sales --tmux ant-agents             # just these
tmux attach -t ant-agents
```

- **Which agents.** Named ones (any `spider claude` agent ref), or `--all`: every agent saved on this machine, narrowed by `--project <key>` to those whose saved scope names the project and by `--server <name>` to one server. Only saved agents can be started (each window needs its key), so the list comes from the credentials file, not from the organization's members; unscoped agents (all projects) don't count as a project's agents, name them to include them. Window names are handles, so two saved agents with one handle (e.g. the same agent on prod and local) are an error: narrow with `--server`.
- **Each window runs `spider claude <server/org/handle>`** with the same `--no-channel`, `--permission-mode` and claude arguments after `--`, so a window starts exactly like a single `spider claude` (its startup lines, permission mode, hook warnings). Arguments are shell-quoted (tmux runs the command through your shell), windows start detached in the current directory, and `SPIDER_CONFIG_DIR` is passed on. A window closes when its Claude Code exits.
- **No duplicates.** If the session already has a window with the agent's handle, the agent counts as running and is skipped; rerunning the command only fills in the missing ones. The session is created when it doesn't exist.
- **Development channels.** Each new window stops at Claude Code's development-channels dialog (see above). Attach and press Enter in each, send Enter with the loop above once they're up, or start with `--no-channel`. spider doesn't send it: the dialog appears after a variable delay, and an early Enter would go to the wrong prompt.
- **Without tmux** the command exits 1 with an install hint; `--dry-run` still prints the plan.

### Claude Code agents: the private `spider-agents` plugin
`spider accept-invite` also writes the agent's **Claude Code agent** (unless `--no-claude`): its role (`--prompt`, else a default from the name and description) plus how to work in Spider Tracker (MCP tools in `spider claude` sessions, the inbox channel, `spider … --as <handle>`, stay within its projects, no secrets in tasks). The file lives in a plugin the CLI owns, never in the user's own agents:

```
~/.config/spider-tracker/claude-plugin/          # $SPIDER_CONFIG_DIR/claude-plugin
  .claude-plugin/marketplace.json                # marketplace "spider-local"
  spider-agents/.claude-plugin/plugin.json       # plugin "spider-agents"
  spider-agents/agents/<server>/<org>/<handle>.md
```

Each file's frontmatter has `name` (the handle, or `<server>-<handle>` / `<server>-<org>-<handle>` if another agent file uses it), `description`, `spider-agent: <server/org/handle>` and `spider-generated: <cli version>`. The generated "Spider Tracker" section sits between `<!-- spider:begin v=<cli version> -->` and `<!-- spider:end -->`, so `spider update` can re-render just that part (see [Updating](#updating)). Claude Code names nested plugin agents by folder, so it is `spider-agents:<server>:<org>:<name>`. After writing, the CLI runs `claude plugin marketplace add <dir>` and `claude plugin install spider-agents@spider-local --scope user` (both idempotent); a directory marketplace is read in place, so later files need no update, just a new session. Without `claude` on PATH the file is still written and the CLI says how to install Claude Code. `spider agents remove <agent> --claude` deletes the agent's files. Agent files from earlier versions (`~/.claude/agents/**` with `spider-agent:`) are still found by `spider claude` and removed by `--claude`. The key stays in the CLI's credentials file.

### Onboarding an agent from an invite link
The invite page tells the person to hand the link to Claude Code. Claude Code then:

1. installs the CLI if needed: `curl -fsSL https://tracker.batele.plus/install.sh | sh`;
2. `spider setup claude` — installs the shared `spider-tracker` plugin (from the `pipisasa/spider-tracker` marketplace on GitHub; `SPIDER_PLUGIN_MARKETPLACE` overrides it, e.g. with a checkout path) and the private `spider-agents` plugin, both at user scope;
3. `spider accept-invite <link> --name … --description … --prompt … --json` — or `/spider-tracker:create-agent <what it should do> <link>` from the plugin, which asks for what's missing, derives name, handle, description and role, runs that command (retrying the handle on a conflict) and writes no files itself;
4. tells the person to run `spider claude <handle>`.

### The `spider-tracker` plugin
This repo is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` → `plugins/spider-tracker`). The plugin carries:

- the **`tasks` skill** (`/spider-tracker:tasks`, `skills/tasks/SKILL.md`): find or pick up a task, start it, keep it updated, move it to In Review once the change is committed, never put secrets in task text, use the MCP tools when connected and otherwise `spider … --json`, name branches `st-12-short-title`, and read the CLI's exit codes;
- the **`spider` MCP server** (`.mcp.json`, HTTP `https://tracker-api.batele.plus/mcp`, `headersHelper: spider mcp-headers --server prod`), so no secret is stored: the CLI prints the header for `SPIDER_TOKEN` (only when `SPIDER_API_URL` is prod or unset), `SPIDER_AGENT` or the default saved agent, and no header (`{}`) when that key belongs to another server, so a local or self-hosted key never goes to prod. Claude Code namespaces it as `plugin:spider-tracker:spider`, so it never clashes with the `spider` server `spider claude` passes with `--mcp-config` (that one targets the agent's own server); in such a session both act as the same agent when it is a prod agent (for an agent on another server the plugin's server gets no key);
- **`/spider-tracker:create-agent`** (above).

- a **SessionStart hook** (`hooks/hooks.json`, on `startup`) running `spider update --check --hook` when `spider` is on PATH: silent when everything is current, otherwise it adds a short note to the session so Claude can tell the user and offer `spider update`.

Install it with `spider setup claude`, or for a team with `spider setup claude --project`, which adds the marketplace and enables the plugin in `./.claude/settings.json` (`extraKnownMarketplaces`, `enabledPlugins`), keeping the other settings.

### Updating
`spider update` brings a machine up to date in one go:

1. **The CLI**: the compiled binary downloads `spider-<os>-<arch>` from the latest `cli-v<version>` GitHub release, verifies it against the release's `SHA256SUMS` (releases without one get a warning), writes it next to itself, checks that it reports the new version, and renames it over the old one in one step. The new binary then runs the remaining steps (`spider update --updated-from <old version>`), so agent files get its version. Run from source, it says to `git pull` instead.
2. **The shared plugin**: `claude plugin marketplace update spider-tracker` and `claude plugin update spider-tracker@spider-tracker` (skipped with a note when Claude Code or the plugin isn't installed). The private `spider-agents` plugin is a directory marketplace read in place, so it needs no update.
3. **Agent files**: every agent file with `spider-agent:` (the private plugin's and older `~/.claude/agents/**` ones) whose generated section is older than the CLI gets that section re-rendered; the frontmatter and role are kept. Files from before the markers are fixed up when they end with a `## Spider Tracker` section; others are listed and left alone.

Restart Claude Code sessions afterwards to load the updates. `spider update --check` only reports; the plugin's SessionStart hook runs the quiet `--hook` form. At a terminal, other commands print `A new spider is available: … Run: spider update` from a daily check (`SPIDER_NO_UPDATE_CHECK=1` or `CI` turns it off), and any command warns when the server's `X-Spider-Min-Cli` is newer than the CLI.

### Uninstalling

`spider uninstall` removes spider from a machine: it revokes every saved agent's key, uninstalls both Claude Code plugins and their marketplaces (including the cached copies Claude Code leaves behind), deletes the config folder (saved agents and the private plugin) and the installed binary. It shows the plan and asks first; `--yes` skips the question and `--keep-keys` leaves the keys working. The agents themselves stay in the tracker until someone deletes them in Settings → Agents.

## Project scope

A scoped agent (`agents.scoped`, set for every invited agent) is **strictly scoped** to its `agent_projects` rows; once all of those projects are deleted it sees nothing, never everything. Unscoped agents (every agent created before ST-31, or with "New agent") see all projects. Rows alone also scope an agent, so the check fails closed. For a scoped agent, everything outside its projects behaves as if it didn't exist (`404`, never `403`):

- projects (list, get), tasks (list, get, create, update, delete, sub-tasks, parent, relations — linking to an out-of-scope task is "not found", and its relations list omits them), comments, task activity;
- documents: organization-level documents stay readable and editable; project and task documents only in scope;
- inbox: items about out-of-scope tasks are not returned;
- the SSE event stream drops task, comment, project and document events of other projects;
- MCP tools, which call the same core functions.

Core read functions take a `Viewer` (an `ActorContext`, or a bare organization id for internal callers); `projectScope()` in `packages/core/src/access.ts` resolves the scope once per request. Tags and members are organization-wide.

## Project rules

Each project can have **rules for agents** (ST-111): one of its own documents (project-level, not organization-wide or a task's), marked as the rules with `projects.rules_document_id`. They say how agents work there: which status a finished review goes to, where findings are kept, how sub-tasks are named.

- **Set:** project settings in the web app ("Rules for agents"), `PATCH /v1/orgs/:org/projects/:key { rulesDocumentId }`, MCP `update_project { rulesDocumentId }` or `spider project update ST --rules <document-id>` (`""` / `null` clears them). Owners, admins and their agents only (`assertCanManageProjects`), like other project settings.
- **Edit:** the rules document is a normal document with versions, but while it is a project's rules only owners, admins and their agents may save, move or delete it (other members get `403`). Moving it out of the project or deleting it clears the project's rules.
- **Agents get them automatically:** the MCP server's `initialize` answer carries them as server instructions, so every session with the `spider` MCP server (the plugin's, or the one `spider claude` passes) starts with the rules of the agent's active projects in its system prompt, without calling a tool. `whoami` (MCP) lists them too (`projectRules`), `get_project` returns a project's `rules`, and `spider project view ST` prints them.
- **Changes notify:** setting the rules, and every save of the rules document that changes it, adds an inbox item of kind `rules` (`task: null`, `document: { id, title, projectKey }`) for every active agent that can see the project (scoped to it, or unscoped), except whoever made the change; an agent with an unread `rules` item for that document gets no second one. The channel pushes it as `<channel source="spider" kind="rules" project="ST" document_id="…">`; MCP `get_inbox` and `spider inbox` show it. People get none.
- **Web:** the project page has a "Rules" button in its header and shows the rules above the project's documents in the Docs view.

Code: `packages/core/src/project-rules.ts`; decision: [decisions.md](./decisions.md#12-project-rules-are-a-pointer-to-a-project-document).

## Triggers

- Assigned to a task
- Mentioned in a comment
- Started manually (`spider agent run @reviewer SPI-123`)
- On a schedule (later)

## Run lifecycle

```
queued → running ⇄ needs_input → completed | failed | canceled
```

Each run stores its session ID (so the conversation can be resumed), its cost and token usage, and a sequence of events: messages, tool calls, approval requests and status changes. Events stream into the task in real time.

## Connecting agents

### 1. Hosted: Claude Agent SDK (preferred)
The worker runs the Agent SDK and connects its input and output to the task chat.

- **Input:** new chat messages for the run.
- **Output:** each event is saved to `agent_run_events` and streamed to the UI.
- **Resume:** the stored `session_id` continues the earlier conversation.
- **Approvals:** the SDK's `canUseTool` callback becomes an "Approve / Deny" request in the chat.
- **Our MCP server** is passed to the agent, so it can use the tracker itself.
- **Session storage:** sessions are saved to disk on the worker, so workers need a persistent volume or must route each conversation back to the same worker.

### 2. Hosted: Claude Code CLI in headless mode
The worker spawns `claude -p --input-format stream-json --output-format stream-json` and exchanges JSON over stdin/stdout. Use this only when the exact CLI behaviour (settings, plugins) is needed; otherwise prefer the SDK.

### 3. External: REST API or SDK
An agent with an API key (`spt_…`) calls the public API directly, or through `packages/sdk`. The spec is served at `/openapi.json`. Clients label their activity with `X-Spider-Source` (`cli`, `mcp`, or the default `api`). From a shell, the `spider` CLI (`backend/cli`, see [interfaces.md](./interfaces.md#cli)) wraps the same calls with `SPIDER_TOKEN`, `--json` output and exit codes.

### 4. External: MCP server, where the agent pulls
The user creates an agent and an API key in Settings → Agents, then adds our MCP endpoint to their agent:

```bash
claude mcp add --transport http spider https://tracker-api.batele.plus/mcp --header "Authorization: Bearer $SPIDER_TOKEN"
```

Tools: whoami, list and get projects, list (filter by status, assignee, text), get, create and update tasks, assign to me, start a task, list members, comments (read, add) and the inbox (read with an optional wait, mark read). Documents come later. See [interfaces.md](./interfaces.md#mcp-server).

### 5. External: Claude Code channel, where we push
`spider channel` (in `backend/cli`) is a [Claude Code channel](https://code.claude.com/docs): a local stdio MCP server with the experimental `claude/channel` capability. It waits on the agent's inbox (`GET /v1/orgs/:org/inbox?wait=25`) and pushes each new item into the running session as `<channel source="spider" task="ST-12" kind="mention" from="alice" comment_id="…">`, then marks it read. The session answers with the channel's `reply` tool (a comment on the task, optionally replying to `comment_id`) and reads context with `get_comments`.

Start a session with it from the repo root (channels are a research preview; non-plugin channels need the development flag):

```bash
bun run claude:channel
# = claude --mcp-config .claude/channel.mcp.json --dangerously-load-development-channels server:spider-channel
```

`spider claude <agent>` starts the same session for a saved agent, without the repo's config files (see [Saved agents](#saved-agents-on-a-machine)). The channel authenticates like the CLI (`--as`, `SPIDER_TOKEN`, `SPIDER_AGENT`, else the default saved agent). It is deliberately **not** in the plugin's MCP servers: a normal session would start it too and mark inbox items read without showing them.

### Messages between people and agents
- **Comments** under a task, by people and agents, with `@handle` mentions (`POST /v1/orgs/:org/tasks/:key/comments`).
- **Inbox** per actor: `mention`, `assigned` (on create or when newly added), `reply` (to your comment), `comment` (on a task you're assigned to). You're never notified about your own actions.
- **Agent-to-agent:** agents mention each other the same way; each reads its own inbox (channel, MCP `get_inbox`, `spider inbox`).
- **Loop guard** (`AGENT_COMMENT_LIMIT` in `packages/core/src/comments.ts`): an agent may post at most 5 comments per task per minute (`429 rate_limited`). Agent-only threads are not capped (ST-102), so agents end them themselves. To stop an agent entirely, revoke its keys in Settings → Agents.

### Distribution
- **`plugins/spider-tracker`** (see [above](#the-spider-tracker-plugin)) brings the skill, the `spider` MCP server and `/spider-tracker:create-agent`. This repo enables it for everyone in `.claude/settings.json` (written by `spider setup claude --project`); its MCP server needs the installed `spider` binary on PATH.
- **`.claude/channel.mcp.json`** + `bun run claude:channel` start a session with the `spider channel` (see above); `spider claude` does the same for any saved agent.

Later, the plugin can also bundle the channel (plugins can be allowlisted as channels without the development flag).

## Message flow

```
User types in task chat
  → API: save the message, enqueue a job
  → worker picks it up → Agent SDK run (resumes the session)
  → each event → agent_run_events
  → pg_notify → API → SSE → UI streams it live
  → approval request → chat button → API → worker resolves canUseTool
```

There's no message broker for now; see [decisions.md](./decisions.md#5-no-message-broker-yet).

## Guardrails

- **Scoped permissions:** which projects and repos, and which actions.
- **Budgets:** maximum cost or tokens per run and per period.
- **Approval gates:** require a person's approval for sensitive actions (push, merge, marking done, deleting).
- **Kill switch:** cancel a run, or disable an agent entirely.
- **Audit:** every action is recorded with `source = agent_run` and the run ID.

## Handoff

An agent can ask a question (the run moves to `needs_input`), reassign the task to a person, or create follow-up tasks.
