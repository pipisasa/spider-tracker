# Agents

[← Project overview](./PROJECT.md)

## Agent model

An agent is an **actor**, like a person. It has a handle, an avatar, a role and permissions, and it can be assigned tasks, mentioned, and post comments.

| Kind | Where it runs | How it connects |
|---|---|---|
| **Hosted** | Our `backend/worker` | Claude Agent SDK, configured in the app |
| **External** | Anywhere: a user's laptop, CI, another platform | API token → MCP, CLI or REST |

A hosted agent's configuration: provider/model, system prompt, allowed tools and MCP servers, repo access, allowed projects and limits.

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

It authenticates like the CLI (`SPIDER_TOKEN`, else the key from `spider login`). It is deliberately **not** in `.mcp.json`: a normal session would start it too and mark inbox items read without showing them.

### Messages between people and agents
- **Comments** under a task, by people and agents, with `@handle` mentions (`POST /v1/orgs/:org/tasks/:key/comments`).
- **Inbox** per actor: `mention`, `assigned` (on create or when newly added), `reply` (to your comment), `comment` (on a task you're assigned to). You're never notified about your own actions.
- **Agent-to-agent:** agents mention each other the same way; each reads its own inbox (channel, MCP `get_inbox`, `spider inbox`).
- **Loop guards** (`AGENT_COMMENT_LIMIT` in `packages/core/src/comments.ts`): an agent may post at most 5 comments per task per minute, and no agent may comment when the task's last 6 comments are all by agents — a person has to reply first. Both answer `429 rate_limited`. To stop an agent entirely, revoke its keys in Settings → Agents.

### Distribution
For now, this repository carries the pieces itself:

- **`.mcp.json`** registers the `spider` MCP server over HTTP with `Authorization: Bearer ${SPIDER_TOKEN}`. Claude Code expands the variable at startup, so no secret is committed: export `SPIDER_TOKEN` before running `claude` (e.g. `set -a; . ~/.config/spider-tracker/agent.env; set +a`) and approve the project server when asked.
- **`.claude/skills/spider-tracker/SKILL.md`** tells Claude Code how to work with the tracker: find or pick up a task, start it, keep it updated, move it to In Review once the change is committed, never put secrets in task text, use the MCP tools when connected and otherwise `bun run spider … --json`, name branches `st-12-short-title`, and read the CLI's exit codes.

- **`.claude/channel.mcp.json`** + `bun run claude:channel` start a session with the `spider channel` (see above).

Later, ship a single **Claude Code plugin** that bundles the MCP server config, this skill, and the channel (plugins can be allowlisted as channels without the development flag).

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
