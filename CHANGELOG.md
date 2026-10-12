# Changelog

Release notes for what reaches users and their scripts: the `spider` CLI (`backend/cli`, released as `cli-v<version>`), the `spider-tracker` Claude Code plugin (`plugins/spider-tracker`) and the MCP server it connects to (`/mcp` in `backend/api`, deployed with the API). When a version is bumped, move its entries from **Unreleased** under that version.

## Unreleased

### MCP server (breaking: tool output shapes, ST-107)

MCP tools now return the same JSON as the CLI's `--json` output, built from the API DTOs ([interfaces.md](docs/interfaces.md#cli-and-mcp-output)). Tool inputs are unchanged. Scripts or prompts that read the old fields need these changes:

- **Lists** are `{ items: [...] }` instead of bare arrays: `list_projects`, `list_documents`, `list_comments`. `list_tasks` returns `{ items, total }` instead of `{ total, tasks }`.
- **Tasks** (`create_task`, `update_task`, `start_task`, `assign_to_me`, `get_task`, `list_tasks`) are the API task plus `status`, `assignees` and `tags`:
  - `status` is an object `{ id, name, category }` instead of the status name: read `status.name`.
  - `priority` is the number 0–4 (0 none, 1 urgent, 2 high, 3 medium, 4 low) instead of its name.
  - `parent` is now `parentKey`; `creator` (a handle) is gone, use `creatorId`. Ids (`id`, `projectId`, `statusId`, `assigneeIds`, `tagIds`, `creatorId`) and `number`, `sortKey` are new.
  - `get_task`: `subtasks` are full tasks instead of `{ key, title, status }`; `documents` are document summaries (see below).
- **Bulk updates** (`update_tasks`): each result is `{ key, outcome, task, error }` with the task under `task` (null on error) instead of its fields spread into the result; `error` is `{ code, message }` instead of the message.
- **Documents**: `project` and `task` are now `projectKey` and `taskKey`; `updatedBy` (a handle) is now `authorId`. `create_document`, `update_document`, `edit_document` and `move_document` return the whole document, `content` included. An older version (`get_document` with `version`) has `authorId` and `createdAt` instead of `savedBy` and `savedAt`, plus `documentId`, `projectKey` and `taskKey`.
- **Comments**: `list_comments` items are the API comment (`authorId`, `taskKey`, `editedAt`, …) plus `author` (the handle, as before). `add_comment` returns the whole comment instead of `{ id, task, createdAt }`.
- **Projects**: `archived` (true/false) is now `archivedAt` (a date or null); `statuses` carry `id`, `color` and `position` too; `id` and `createdAt` are new. `get_project`'s `documents` are document summaries (`taskKey` instead of `task`).
- **Project rules** (ST-111; `rules` on `get_project`, `projectRules` on `whoami`) are the API's `ProjectRulesDto` plus `url`: `project` is now `projectKey`, and `projectName` and `format` are new.
- **Document diffs** (`diff_document`, ST-117) are the API's diff plus the unified `diff` text: `id` is now `documentId`; `from`/`to` have `authorId` and `createdAt` instead of `savedBy` and `savedAt`; `hunks` (the structured lines) are new.

- **Backlinks and the documents graph** (ST-101): `list_backlinks` returns `{ items }` of document summaries instead of a bare array. `get_document_graph` returns the API's graph: documents are summaries (`projectKey`, `taskKey`, `version`, … instead of `project`, `task`), tasks have `projectKey` and `statusCategory` instead of `status`. `update_document` still adds `relinked` to the document after a rename.

Unchanged: `whoami` (apart from `projectRules`), `get_inbox`, `get_task_activity`, `list_tags`, `list_members`, `link_tasks`, `unlink_tasks`, `mark_inbox_read`, `create_tag`.

### Start and target dates (ST-91)

- **API:** tasks carry `startDate` and `targetDate` (`YYYY-MM-DD` or `null`); create, update and bulk update take them (start ≤ target). `GET …/projects/:key/tasks?overdue=true` lists open tasks past their target date (today = the server's UTC date). SDK: the same fields and `tasks.list(…, { overdue: true })`.
- **MCP:** `create_task`, `update_task` and `update_tasks` take `startDate` / `targetDate` (null clears on update); `list_tasks` and the `update_tasks` filter take `overdue`. Task outputs gain the two fields (additive).
- **CLI:** `--start` / `--target` on `task create` and `task update` (`""` clears), `--set-start` / `--set-target` for several keys or `--project`, and `task list --overdue`. `task view` shows the dates; `task list` rows show `due <date>`, marked `(overdue)`. `--json` task output gains `startDate` and `targetDate`.
- **Web:** start and target date fields in the task page sidebar; list rows show the target date (red when overdue); an "Overdue" filter on the project page, kept in saved views.
- Database migration `0018_task_dates` (two nullable columns and a check constraint).

### Document comments (ST-118)

- Comments on documents, so reviews stay on the document instead of landing in a task's comments: on the whole document or on a quoted fragment (`quote`), with replies, @-mentions and a resolved mark. A comment whose fragment has changed stays and is marked `outdated`.
- MCP: new tools `add_document_comment`, `list_document_comments` and `resolve_document_comment`. `get_inbox` returns the new kinds `document_mention`, `document_reply` and `document_comment` with `project` and `document: { id, title, url }` instead of `task`.
- CLI: new `spider doc comment <id> "…" [--quote …] [--reply-to …]`, `spider doc comments <id>` and `spider doc resolve <id> <commentId> [--reopen]`; `spider inbox` and `spider channel` deliver the new kinds, and the channel's `reply` and `get_comments` tools take `document_id` instead of `task` for them.
- API: `GET|POST /v1/orgs/{org}/documents/{id}/comments` and `PATCH …/comments/{commentId}` (`{ resolved }`). `GET /inbox` returns `document_*` items only when `kinds` asks for them, so older CLIs are unaffected; inbox items' `document.projectKey` can now be null (an organization-wide document).
- Database migration `0019_document_comments` (`comments.task_id` nullable, new `document_id`, `quote`, `document_version`, `resolved_at`, `resolved_by`, and two check constraints).

### CLI

- New `spider task duplicate [key] --of KEY [--comment "…"]` closes a task as a duplicate in one step (link, canceled status, comment); MCP has the matching `mark_duplicate` tool. `link_tasks` now refuses a `duplicates` link that would close a cycle (ST-114).
- `task view --json` adds `documents`; `project view --json` adds the project's `documents`, and its `rules` gain `projectKey`, `projectName`, `format`, `updatedAt` and `url` (the full `ProjectRulesDto`); `doc diff --json` adds `diff` (the unified text); `comment --json` and `comments --json` add `author` (the handle). Nothing was removed or renamed (ST-107).
- `task update` and other commands that fail with "not found" or "forbidden" while acting as a saved agent limited to some projects say which agent acted, how it was chosen (`--as`, `SPIDER_AGENT` or the default agent) and which projects it sees: a task in another project reads as missing to it (ST-107).
- An error response without a JSON body (a proxy page, or HTTP/2 without status text) no longer prints an empty `spider: ` line; it says which request failed with which HTTP status (ST-107).
- `spider doc publish <dir> [--project ST] [--dry-run]` creates or updates documents from a folder's `.md` files in one command (ST-119). Front matter maps a file to its document (`title`, `project`, `task`; publish writes back `id` and `version`), so a rerun updates instead of duplicating. `[[Title]]` and relative `.md` links between the files are published as `[[doc:<id>]]` links. Updates are based on the file's `version`: a document changed in the tracker since then is reported as a conflict and not overwritten (no `--force`). One line per file (`created`, `updated`, `unchanged`, `conflict`, `failed`); `--json` prints `{ dryRun, results, summary }`; exit code `1` when any file is a conflict or failed.

### API

- `POST /v1/orgs/{org}/tasks/bulk-update`: tasks in `results` carry `url`, like other task responses (ST-107).
- `GET /v1/orgs/{org}/documents/graph`: `projects` carry `url` too (ST-107).

### Plugin 0.3.8

- The `tasks` skill explains document comments: feedback goes on the document (`add_document_comment` / `spider doc comment`, with `quote` for a fragment), not in task comments (ST-118).

### Plugin 0.3.7

- The `tasks` skill mentions `spider doc publish <dir>` for publishing a set of documents from local files (ST-119).

### Plugin 0.3.6

- The `tasks` skill says that MCP and CLI `--json` return the same shapes, and what a "not found" from the CLI for a task MCP can see usually means (ST-107).
