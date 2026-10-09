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

### 3. External: MCP server, where the agent pulls
The user creates an agent and an API key in Settings → Agents, then adds our MCP endpoint to their agent:

```bash
claude mcp add --transport http spider https://tracker-api.batele.plus/mcp --header "Authorization: Bearer $SPIDER_TOKEN"
```

Tools: whoami, list and get projects, list (filter by status, assignee, text), get, create and update tasks, assign to me, start a task, list members. Comments and documents come later. See [interfaces.md](./interfaces.md#mcp-server).

### 4. External: channel plugin, where we push
A Claude Code channel plugin pushes chat messages and new assignments into a user's running Claude Code session, and exposes a reply tool. This feature is a research preview; check current docs before building on it.

### Distribution
Ship a single **Claude Code plugin** that bundles the MCP server config, a skill describing `spider` CLI workflows, and the optional channel.

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
