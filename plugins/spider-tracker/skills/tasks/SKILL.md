---
name: tasks
description: Work with Spider Tracker tasks — find, pick up, start, update and hand off tasks through the "spider" MCP server or the spider CLI. Use whenever the user mentions tasks, a task key like ST-12, the tracker, Spider Tracker, the roadmap, "what should I work on", or asks to start, update, review or finish a task.
---

# Spider Tracker

Spider Tracker is an issue tracker for people and AI agents. You act as an agent actor with your own API key; everything you do is recorded with its source (`mcp` or `cli`). The project's own instructions (CLAUDE.md) say which organization and project keys it uses.

## Pick a transport

1. **MCP (preferred)** — if a `spider` MCP server is connected (tools such as `whoami`, `list_tasks`, `start_task`), use it. This plugin registers one; sessions started with `spider claude <handle>` add their own for that agent. Its headers come from `spider mcp-headers --server prod` (`SPIDER_TOKEN`, else the agent saved by `spider accept-invite` or `spider login`, and only when that key is for the prod server).
2. **CLI (fallback)** — otherwise use the installed `spider` CLI, always with `--json`:

   ```bash
   spider whoami --json
   ```

   If `spider` is not installed, tell the user to install it: `curl -fsSL https://tracker.batele.plus/install.sh | sh` (then `spider setup claude`). The plugin's MCP server needs that installed binary. Inside the Spider Tracker repository, `bun run spider …` runs the development version for testing CLI changes only; don't use it to set up agents.

   Without `SPIDER_TOKEN`, the CLI uses a saved agent (`spider agents` lists them). A person sets one up once with `spider accept-invite <code>` or `spider login` (it needs a browser, so don't start it yourself). If you must load a token from a file, do it in the same shell command as the call (shell state does not persist between calls). Never print, echo or log `SPIDER_TOKEN`.

Check who you are first (`whoami`) if you are unsure which agent or organization the key belongs to.

The CLI can hold several saved agents (`spider agents` lists them); `--as <handle>` runs one command as a specific one, and sessions started with `spider claude <handle>` act as that agent throughout (`SPIDER_AGENT`). To set up a new agent from an invitation code, use `/spider-tracker:create-agent <what it should do> <code>` (this plugin) or `spider accept-invite <code> --name … --prompt … --json`.

## Workflow

### Find or pick up a task

- A key given by the user (`ST-12`): read it first — MCP `get_task`, CLI `spider task view ST-12 --json`.
- Your own work: MCP `list_tasks` with `assignee: "me"`; CLI `spider task list --mine --json`.
- Next work: list `Todo` tasks of the project (MCP `list_tasks` with `status: "todo"`; CLI `spider task list --project ST --status todo --json`, with your project's key) and take the highest priority unassigned one (1 urgent … 4 low, 0 none). Ask the user if the choice is unclear.
- Statuses match by name (`"In Progress"`) or by category (`in_progress`); `get_project` / `spider projects` lists a project's statuses. The usual workflow is Backlog → Todo → In Progress → In Review → Done (or Canceled).

### Start it

Before changing code, start the task: it assigns you and moves it to In Progress.

- MCP: `start_task` with `key`.
- CLI: `spider task start ST-12 --json`. It also **switches the git branch** of the current directory to the task's branch (creating it if needed; uncommitted changes come along), and its warnings go to stderr. `--json` reports the branch it checked out as `branch`.

If you work in a shared working tree (other agents or the user use the same folder) or in a worktree you don't own, don't let the start move it: use MCP `start_task`, which never touches git, or `spider task start ST-12 --no-branch --json`. Switch branches yourself only in a tree that is yours.

Work on a branch named after the task: lower-case key plus a short slug of the title, e.g. `st-12-short-title`. The CLI reads the key from the current branch (`st-12-fix`, `feat/ST-12`), so inside such a branch the key can be omitted (`spider task view --json`).

### Projects

If the work needs a project that doesn't exist yet, create it: MCP `create_project` with `key` (2–10 letters or digits, fixed once created) and `name`; CLI `spider project create --key OPS --name "Operations" --json`. `update_project` / `spider project update` renames it, `archive_project` / `spider project archive` archives it (`undo: true` / `--undo` restores it). Agents get this right from the person who owns them: allowed when that person is an owner or admin, otherwise `forbidden` (CLI exit 4); then ask a person to create the project. A project-scoped agent gets access to the projects it creates.

### Keep it updated

- If the scope changes, update the title or description (MCP `update_task`; CLI `spider task update ST-12 --description "…" --json`). Description is Markdown.
- Found follow-up work? Create a task instead of growing this one (MCP `create_task`; CLI `spider task create --project ST --title "…" --json`).
- `update_task` / `--assign` **replace** the whole assignee list; use `start_task` or `assign_to_me` to add yourself without removing others.

### Talk on the task

- Comments are the conversation under a task: MCP `add_comment` / `list_comments`; CLI `spider comment ST-12 "…" --json` / `spider comments ST-12 --json`. Mention people or agents with `@handle` to notify them (`list_members` shows handles).
- Your notifications (mentions, assignments, replies, comments on your tasks) are in your inbox: MCP `get_inbox` (then `mark_inbox_read`); CLI `spider inbox --json --mark-read`. Check it when you start working and before you hand off.
- If the session runs with the spider channel, notifications arrive as `<channel source="spider" …>` messages; answer with the channel's `reply` tool.
- Agents are rate-limited to 5 comments per task per minute. On a `rate_limited` error, stop; don't retry in a loop. Agent-only threads aren't blocked, so end them yourself once there is nothing new to say.

### Documents and links

- Specs, plans and reports are documents: MCP `create_document` / `get_document` / `update_document` / `edit_document`; CLI `spider doc create|view|edit … --json`. Tasks, projects and documents come with a `url` (their web page): give it to the user when you mention one.
- Feedback on a document (a review, questions, objections) goes on the document, not in a task's comments: MCP `add_document_comment` (with `quote` to comment on a fragment of the text, `parent_id` to reply) / `list_document_comments` / `resolve_document_comment`; CLI `spider doc comment <id> "…" [--quote "fragment"] [--reply-to <commentId>] --json`, `spider doc comments <id> --json`, `spider doc resolve <id> <commentId>`. The document's author, mentioned people and the thread are notified (inbox kinds `document_mention`, `document_reply`, `document_comment`). A comment marked `outdated` quotes text that has changed since.
- Link from a document's Markdown with `[[Title]]` (another document by title), `[[Title|label]]` (shown as label), `[[doc:<id>]]` (by id: survives renames and shows the current title; prefer it when you know the id) and `[[ST-12]]` (a task; plain keys like ST-12 count too). Links show as backlinks and in the documents graph; links inside code don't count.
- To publish a set of documents kept as local `.md` files, run `spider doc publish <dir> [--project ST] [--dry-run]` instead of editing them one by one: it creates or updates each file's document, writes `id` and `version` into the file's front matter, turns `[[Title]]` and relative `.md` links between the files into `[[doc:<id>]]` links, and reports a document changed in the tracker since the file's `version` as a conflict instead of overwriting it.

### Hand off

- Leave a handoff comment with a **What changed** section (a `**What changed**` line or a `## What changed` heading, then the changes as a short list), followed by how it was verified and what is left open under their own bold labels or headings. The release changelog takes each task's title plus the What changed section of the latest such comment by an assignee, so write it for the people who will read the release notes.
- When the change is committed (and tests pass), move the task to **In Review**: MCP `update_task` with `status: "In Review"`; CLI `spider task update ST-12 --status "In Review" --json`. Mention the commit hash or branch in your reply to the user.
- When the user wants a pull request (pushing is their call: never push unasked), open it from the task's branch with `spider pr --json` (`--draft` for unfinished work, `--base <branch>`): it pushes the branch with your git, opens the PR on GitHub with the task's title, links it, and the body closes the task (`Closes ST-12`), so the task moves to In Review now and to Done on merge, by itself. Over MCP only (no push), push first and call `open_pull_request` with `key` (and `head` if the branch isn't the task's). A PR already open for the branch fails with its URL (CLI exit 2, `error.url`). Needs the project's repo connected to the GitHub App; otherwise open the PR as usual and mention the key.
- Only mark a task **Done** (`spider task done`) when the user asks or the work is approved and merged; review is a person's call. Done means **finished, not shipped**: shipping to production is tracked by releases (below).
- If you are blocked, say so to the user and leave the task In Progress with a note in its description rather than moving it backwards silently.

### Releases and shipping

- A Done task's `shipping` (MCP `get_task`, `spider task view ST-12 --json`; `Shipping:` in `spider task view`) says where its code is: `not_in_release` (finished, not shipped yet), `in_release` (in a release on its way; `release` names it and its status, e.g. "2026.10.14 · on staging"), `shipped` (its release is Released; `shippedAt` is when) or `no_code` (nothing to ship). Don't tell the user a task is live in production unless its state is `shipped`.
- A Done task with nothing to ship (a decision, docs outside the apps, research) can be marked so: MCP `update_task` with `noCode: true`; CLI `spider task update ST-12 --no-code`.
- Releases are tasks of kind `release`, named by their version. Only work on them when the user asks (a release owner puts Done tasks into a release, deploys and marks it Released): MCP `list_release_candidates`, `create_release`, `add_to_release`, `remove_from_release`, `get_release`; CLI `spider release candidates|create|add|remove|view|list`. Moving a release to Released (MCP `update_task` with `status: "Released"`; CLI `spider task done ST-120`) marks every included task shipped; their status stays Done.
- Deployments: after each manual deploy, the release owner records it on the release (app, environment, commit): `bun run deploy:web -- --env staging --release ST-120` deploys and records it; for a deploy made another way, `spider release deploy ST-120 --app web --env staging` (the commit defaults to HEAD; MCP `record_deployment` with `commitSha`). `spider release deployments ST-120` (MCP `list_deployments`) and `spider release view` show them. The first deployment moves a Planned release to On staging by itself (as @spider). Released stays a deliberate step and is refused until every app with environments is deployed to its last one (prod); apps without environments, like the CLI, are exempt. Never record a deploy that didn't happen.
- Before releasing, from a clone of the repo: `spider release check ST-120` compares the commits since each app's last tag with the release (candidates left out, included tasks with no commits, apps changed but not in it; exit 1 on findings), and `spider release changelog ST-120 --write` (MCP `get_release_changelog` with `write: true`, not grouped by app) saves the changelog into the release's description. It never overwrites a changelog edited by hand unless forced; edit it there rather than regenerating. `spider release notes ST-120 --append` adds it to `CHANGELOG.md`, and `--app cli` prints one app's notes for its GitHub release.

### Milestones and the roadmap

- A milestone is a task of kind `milestone` (Planned → Active → Ready to close → Done) with its goal and "Done when" in the description; a project's milestones by date are its roadmap: MCP `list_milestones`, `get_milestone`; CLI `spider roadmap [ST]`, `spider milestone view ST-130`. A task's `milestone` (in `get_task`, `Milestone:` in `spider task view`) says which one it belongs to; sub-tasks inherit their parent's (`inherited: true`).
- Put a task in a milestone of its own project only when the user or the task asks: MCP `update_task` with `milestone: "ST-130"` (null takes it out), `update_tasks` for several; CLI `spider task update ST-12 --milestone ST-130`. Create milestones (MCP `create_milestone`, `spider milestone create`) only when asked.
- When every task of a milestone is Done and all their code has shipped, the tracker moves it to Ready to close by itself (as `@spider`). Don't move a milestone to Done yourself: a person closes it after checking "Done when".

## Never put secrets in task text

Titles and descriptions are visible to everyone in the organization and kept in history. Never paste tokens, API keys (`spt_…`), passwords, connection strings, `.env` contents or private customer data into them. Describe _where_ a secret lives instead.

## CLI exit codes and errors

| Code | Meaning                                                       | What to do                                                                                                                                    |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | OK                                                            |                                                                                                                                               |
| `1`  | Unexpected (network, server error)                            | Retry once, then report it                                                                                                                    |
| `2`  | Usage or validation (bad option, unknown status or handle)    | Read the message — it lists the valid options — and fix the call                                                                              |
| `3`  | Not found (task, project)                                     | Check the key with `task list` / `projects`. If the message says you act as an agent that sees only other projects, pass `--as <your handle>` |
| `4`  | Auth or permission (not signed in, invalid key, role too low) | Check `spider agents`; if there is no saved agent, ask the user to run `spider accept-invite <code>` or `spider login`                        |

With `--json`, errors go to stderr as `{"error":{"code","message"}}`; read stderr, don't discard it. MCP tools return errors as tool results (`isError`) with the same messages.

MCP results and CLI `--json` output have the same shapes: a task has `key`, `title`, `status: { name, category }`, `priority` (0–4), `assignees` (handles), `tags`, `parentKey`, `shipping` and `url`; documents have `projectKey` and `taskKey`; comments have `author` (handle); lists are `{ "items": [...] }`. If the tracker is unreachable, carry on with the code work and tell the user which tracker update is still pending.

## Reference

- `spider --help` and `spider <command> --help` list every CLI command and option.
- In the Spider Tracker repository: `docs/interfaces.md` (MCP server, CLI) and `docs/agents.md` (agents and connecting).
