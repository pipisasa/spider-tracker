---
name: spider-tracker
description: Work with Spider Tracker tasks — find, pick up, start, update and hand off tasks through the "spider" MCP server or the spider CLI. Use whenever the user mentions tasks, a task key like ST-12, the tracker, Spider Tracker, the roadmap, "what should I work on", or asks to start, update, review or finish a task.
---

# Spider Tracker

Spider Tracker is this repository's issue tracker, and its roadmap lives there (project `ST`, org `batele`). You act as an agent actor with your own API key; everything you do is recorded with its source (`mcp` or `cli`).

## Pick a transport

1. **MCP (preferred)** — if the `spider` MCP server is connected (tools such as `whoami`, `list_tasks`, `start_task`), use it. It is registered in the repo's `.mcp.json` and reads `SPIDER_TOKEN` from the environment Claude Code was started in.
2. **CLI (fallback)** — otherwise use the `spider` CLI from the repo root, always with `--json`:

   ```bash
   set -a; . ~/.config/spider-tracker/agent.env; set +a   # loads SPIDER_TOKEN, if that file exists
   bun run spider whoami --json
   ```

   Load the token in the same shell command as the call (shell state does not persist between calls). Without `SPIDER_TOKEN`, the CLI uses the key saved by `spider login` (a person runs it once; it needs a browser, so don't start it yourself). Never print, echo or log `SPIDER_TOKEN`.

Check who you are first (`whoami`) if you are unsure which agent or organization the key belongs to.

## Workflow

### Find or pick up a task
- A key given by the user (`ST-12`): read it first — MCP `get_task`, CLI `spider task view ST-12 --json`.
- Your own work: MCP `list_tasks` with `assignee: "me"`; CLI `spider task list --mine --json`.
- Next work from the roadmap: list `Todo` tasks (MCP `list_tasks` with `status: "todo"`; CLI `spider task list --project ST --status todo --json`) and take the highest priority unassigned one (1 urgent … 4 low, 0 none). Ask the user if the choice is unclear.
- Statuses match by name (`"In Progress"`) or by category (`in_progress`); `get_project` / the API lists a project's statuses. The `ST` workflow is Backlog → Todo → In Progress → In Review → Done (or Canceled).

### Start it
Before changing code, start the task: it assigns you and moves it to In Progress.
- MCP: `start_task` with `key`.
- CLI: `spider task start ST-12 --json`.

Work on a branch named after the task: lower-case key plus a short slug of the title, e.g. `st-12-short-title`. The CLI reads the key from the current branch (`st-12-fix`, `feat/ST-12`), so inside such a branch the key can be omitted (`spider task view --json`).

### Keep it updated
- If the scope changes, update the title or description (MCP `update_task`; CLI `spider task update ST-12 --description "…" --json`). Description is Markdown.
- Found follow-up work? Create a task instead of growing this one (MCP `create_task`; CLI `spider task create --project ST --title "…" --json`).
- `update_task` / `--assign` **replace** the whole assignee list; use `start_task` or `assign_to_me` to add yourself without removing others.

### Hand off
- When the change is committed (and tests pass), move the task to **In Review**: MCP `update_task` with `status: "In Review"`; CLI `spider task update ST-12 --status "In Review" --json`. Mention the commit hash or branch in your reply to the user.
- Only mark a task **Done** (`spider task done`) when the user asks or the work is merged and released; review is a person's call.
- If you are blocked, say so to the user and leave the task In Progress with a note in its description rather than moving it backwards silently.

## Never put secrets in task text
Titles and descriptions are visible to everyone in the organization and kept in history. Never paste tokens, API keys (`spt_…`), passwords, connection strings, `.env` contents or private customer data into them. Describe *where* a secret lives instead.

## CLI exit codes and errors
| Code | Meaning | What to do |
|---|---|---|
| `0` | OK | |
| `1` | Unexpected (network, server error) | Retry once, then report it |
| `2` | Usage or validation (bad option, unknown status or handle) | Read the message — it lists the valid options — and fix the call |
| `3` | Not found (task, project) | Check the key with `task list` / `projects` |
| `4` | Auth or permission (not signed in, invalid key, role too low) | Load the token from `~/.config/spider-tracker/agent.env`; if there is none, ask the user to run `spider login` |

With `--json`, errors go to stderr as `{"error":{"code","message"}}`. MCP tools return errors as tool results (`isError`) with the same messages. If the tracker is unreachable, carry on with the code work and tell the user which tracker update is still pending.

## Reference
- MCP tools and CLI commands: `docs/interfaces.md` (MCP server, CLI sections).
- Agent model and connecting: `docs/agents.md`.
