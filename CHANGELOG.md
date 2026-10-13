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

### Releases and changelogs within an agent's project scope (ST-93, ST-95 follow-up)

- **API (behavior change for project-scoped agents):** releasing, unreleasing, canceling or deleting a release that includes tasks outside the agent's projects is refused (`403`, without naming them); so is writing its changelog. A release's `repos`, `apps` and `deployments` list only those in repos attached to the agent's projects, `PATCH …/releases/:key { repos, apps }` from it keeps the links it can't see, and `release deploy` only finds apps it can see. Task activity no longer names a release the reader can't see: `task.shipped`/`task.unshipped` read `{ releaseId, release, version }` (all null when hidden), a hidden `releaseId` reads `"hidden"`, and a release's `repos`/`apps`/`release.deployed` entries drop hidden repos.
- **Changelog (behavior change):** the generated changelog holds only the tasks of the release's own project and its apps in repos attached to that project, for every reader (other projects' titles and notes are never written into the description). Marker strings and leading `#`, `*`, `_` in titles and notes are escaped; `#` lines inside fenced code in a note stay as they are.
- **CLI:** `spider release check` warns when an app of the release has no earlier tag (run `git fetch --tags`, or pass `--since`).

### Deployments (ST-94)

- **API:** new `POST /v1/orgs/:org/releases/:key/deployments` (`{ app, repo?, environment, commitSha }`, 201 with `{ deployment, release, movedFrom }`) and `GET …/releases/:key/deployments[?app=&environment=]`. A deployment is one of the release's apps deployed to one of the app's environments at a commit, by whom, when (`DeploymentDto`, with `production` for the app's last environment). Releases carry `deployments` (newest first). The first deployment moves a Planned release to On staging as the `@spider` bot; nothing moves a release backwards. **Behavior change:** moving a release to Released is refused until every app with environments has a deployment to its last one (prod); apps without environments, like the CLI, are exempt. SDK: `releases.deploy`, `releases.deployments`.
- **MCP:** new `record_deployment` and `list_deployments`; release output (`get_release`, …) gains `deployments`.
- **CLI:** `spider release deploy ST-NN --app web --env staging [--commit <sha>]` (the commit defaults to HEAD) and `spider release deployments ST-NN [--app] [--env]`; `release view` lists the latest deployment per app and environment, and `--json` releases gain `deployments`.
- **Deploy scripts:** `bun run deploy:web` and `bun run deploy:api` now run `scripts/deploy.ts`, which deploys as before and, only with `-- --release ST-NN`, records the deployment (`--env staging` deploys to staging; see docs/deployment.md).
- **Plugin 0.3.13:** the tasks skill explains how the release owner records deployments and when Released is allowed.

### Milestones and the project Roadmap (ST-96)

- **API:** tasks carry `milestoneId` (their own; a milestone of the same project) and `milestone { id, key, title, status, inherited }` (own, or inherited from the nearest ancestor). `POST …/tasks`, `PATCH /tasks/:key` and bulk `set` take `milestoneId` (`null` takes a task out). New `GET|POST /v1/orgs/:org/projects/:key/milestones[?status=]` (the roadmap, by target date) and `GET /v1/orgs/:org/milestones/:key`, each `MilestoneDto` with `progress { total, done, canceled, withCode, shipped, complete }`, `tasks` and `releases`. When every task of an open milestone is Done and all their code has shipped, the tracker moves it to Ready to close as the `@spider` bot (activity source `system`, now in the OpenAPI enum); `spider` is a reserved handle. SDK: `milestones.list|get|create`.
- **MCP:** new `list_milestones`, `get_milestone`, `create_milestone`; `create_task`, `update_task` and `update_tasks` take `milestone` (a milestone's key; null takes it out). Tasks in every tool's output have `milestoneId` and `milestone`.
- **CLI:** `spider roadmap [project] [--status]`, `spider milestone list|view|create`, and `--milestone <key>` on `task create` and `task update` (`--set-milestone` with `--project`). `task view` shows the milestone.
- **Roadmap import:** `bun run roadmap:import --as <agent> [--dry-run]` creates one milestone per phase of `docs/roadmap.md` in ST and puts the existing tasks in them; it is idempotent and never moves a task out of a milestone a person chose.

### Task kinds and per-project workflows (ST-90)

- **API:** tasks carry `kind` (`task`, `release`, `milestone`; default `task`, fixed at creation). Projects have one workflow per kind: `ProjectDetailDto.workflows` (`{ task, release, milestone }`), statuses gain `kind`, and `statuses` stays the task workflow. New projects get all three default workflows; the migration gives existing projects the release and milestone ones. New `POST …/projects/:key/statuses`, `PATCH|DELETE …/statuses/:id?moveTo=` edit workflows (owners, admins and their agents). `POST …/tasks` takes `kind`; `GET …/tasks?kind=` filters by it. A task's status must be of its own project and kind (create, update, bulk update, duplicates). SDK: `projects.statuses.create|update|delete`, `tasks.list(…, { kind })`.
- **MCP:** new `create_status`, `update_status` and `delete_status` tools; `list_tasks` and the `update_tasks` filter take `kind`. Status names in `update_task`, `update_tasks`, `start_task` and `mark_duplicate` match the workflow of each task's kind. Output (additive): tasks gain `kind`; `get_project` and the project tools gain `workflows`, and statuses gain `kind`. `list_tasks` with a status name and no `kind` now also matches release and milestone statuses of that name.
- **CLI:** new `spider project status [list] | add | update | delete` (`--kind`, default task). `task list --kind`. `--status`, `task start` and `task done` use the workflow of the task's kind. `--json` output (additive): tasks gain `kind`; projects gain `workflows` (`project view` with `taskCount` there too) and statuses `kind`. Human `project view` now lists each workflow with categories (`Task workflow:` …) instead of one `Statuses:` list.
- **Web:** Settings → Projects → Workflows: add, rename, recolor, reorder and delete statuses of each kind's workflow. The board and list show tasks of kind `task`.
- Database migration (task kinds): `task_kind` enum, `kind` on `statuses` and `tasks`, names unique per workflow regardless of case, and the default release and milestone workflows for existing projects.

### Releases (ST-93)

Done means finished, not shipped; releases ship Done tasks.

- **API:** tasks gain `releaseId`, `shippedAt`, `noCode` and `shipping` (`{ state: not_in_release | in_release | shipped | no_code, release }`; null for releases, milestones and tasks that aren't Done and in no release). `PATCH /tasks/:key` and bulk updates take `noCode`. New `GET|POST /v1/orgs/{org}/projects/{key}/releases`, `GET|PATCH /v1/orgs/{org}/releases/{key}`, `POST …/releases/{key}/tasks`, `DELETE …/releases/{key}/tasks/{taskKey}` and `GET /v1/orgs/{org}/release-candidates`. Moving a release to Released ships its tasks (`shippedAt`, activity `task.shipped` "shipped in <version>"), and needs them all Done; moving it back unships them; canceling or deleting it takes its tasks out. SDK: `releases.*`.
- **MCP:** new `create_release`, `get_release`, `list_releases`, `update_release`, `add_to_release`, `remove_from_release` and `list_release_candidates` (same JSON as `spider release … --json`); `update_task` and `update_tasks` take `noCode`. Task outputs gain the four fields above (additive).
- **CLI:** new `spider release list|view|create|update|add|remove|candidates` (`--app web=2026.10.13`, default repo the origin remote) and `spider task update --no-code` / `--code`. `task view` shows `Shipping: …`; `task list` rows of Done tasks show `[not in a release]`, `[2026.10.14 · on staging]`, `[shipped 2026.10.13]` or `[no code]`. `--json` task output gains the four fields.
- **Web:** the board shows release columns after the task columns (one per release status, a "Release columns" switch, on by default) with release cards (version, apps, task keys); Done cards show their shipping state; dragging a Done task onto a release card adds it. A Releases view per project: releases in flight, then the shipped ones as the changelog, filterable by app. A release's page shows its apps, versions and tasks (add, remove); a Done task's page shows its shipping and a "No code to ship" switch.
- Database migration `0024_releases`: `tasks.release_id`, `shipped_at`, `no_code`, and the `release_repos` and `release_apps` tables.

### Release changelog and git check (ST-95)

- **API:** new `GET /v1/orgs/{org}/releases/{key}/changelog` (`ReleaseChangelogDto`: each included task's title plus the "What changed" section of its handoff note, by app for a one-app release, as `entries` and `markdown`, and how the description's changelog block compares: `missing`, `current`, `outdated` or `edited`) and `POST …/changelog { taskApps?, force? }`, which writes it into the release's description between `<!-- spider:changelog -->` markers, keeping the rest; a block edited by hand is `409` unless `force`. SDK: `releases.changelog`, `releases.writeChangelog`.
- **MCP:** new `get_release_changelog` (`key`, `write`, `force`), the same JSON as `spider release changelog --no-git --json`.
- **CLI:** new `spider release changelog ST-NN [--write [--force]] [--no-git]` (grouped by app from local git), `spider release check ST-NN [--ref] [--since]` (commits since each app's previous tag vs the release: candidates left out, included tasks with no commits, apps changed but not in the release; exit 1 on findings) and `spider release notes ST-NN [--app cli] [--append [file]]` (one app's notes with its tag, or the release's section added to `CHANGELOG.md` after Unreleased, once). `bun run release:cli --release ST-NN` uses the cli section as the GitHub release notes.

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

### Opening pull requests (ST-87)

- CLI: new `spider pr [key] [--draft] [--base <branch>] [--no-push] [--repo owner/name]` (also `spider task pr`): pushes the current branch with your own git, then opens its pull request on GitHub as the Spider Tracker App and links it to the task (default: the branch's task). The title is the task's (`<title> (KEY)`) and the body closes it (`Closes KEY`), so the task moves to In Review now and to Done on merge. `--json` prints `{ taskKey, pullRequest }`; a PR already open for the branch exits 2 with its URL (`error.url` in `--json` errors).
- MCP: new tool `open_pull_request` for a branch already pushed, returning the same JSON as `spider pr --json`.
- API: `POST /v1/orgs/{org}/tasks/{key}/pull-request` `{ repo?, head?, base?, title?, body?, draft? }` → `201 { taskKey, pullRequest }`; `409` with `error.url` when a PR is already open for the branch, `400` for no or ambiguous repo or GitHub's refusal, `502` GitHub unavailable, `503` without the App. Error bodies may now carry `error.url`. SDK: `tasks.openPullRequest`, and `SpiderApiError.url`.
- The GitHub App needs **Pull requests: read and write** ([git-integration.md](docs/git-integration.md#opening-pull-requests-st-87)).

### Status automation from pull requests (ST-85)

- A `pull_request` event moves the tasks it is linked to by closing keyword, branch or title (a mention in the body doesn't): opened as or converted to a draft → In Progress, opened, reopened or ready for review → In Review, merged → Done (once no other linked PR is open), closed without merging → no change. Forward only (except a draft moving In Review back to In Progress), only tasks of kind `task`, as the @github bot with source `git` ([git-integration.md](docs/git-integration.md#status-automation-st-85)).
- Per project, on by default: `ProjectDto.gitAutomation` `{ enabled, draft, opened, merged, closed }` (status categories or null). API: `PATCH …/projects/{key}` takes `gitAutomation` (partial; `null` resets). MCP: `update_project` takes `gitAutomation`. CLI: `spider project update KEY --automation on|off|defaults --on-draft|--on-opened|--on-merged|--on-closed <category|none>`; `project view` shows the settings. Web: Status automation in project settings.
- Database migration `0026_git_automation` (`projects.git_automation`).
- Safer automation (review follow-up): a merge moves a task only when the PR's base is the repo's default branch (a stacked PR or a merge into a release or feature branch moves nothing); PRs from forks, or by authors who aren't an owner, member or collaborator of the repo (bots excepted), still link but never move tasks; archived projects aren't automated; the activity entry names the pull request, the event and who sent it (`changes.pullRequest` `{ number, event, sender }`, e.g. who merged).

### Branches, commits and pull requests on tasks (ST-84)

- GitHub `create`, `delete`, `push` and `pull_request` webhooks link branches named after a task, commits that mention it (or were pushed to its branch) and pull requests that name it in their branch, title or body. Only keys of tasks in projects attached to the repo count. Each link says how it was found (`via`: `closing`, `branch`, `title`, `body`, `message`). A `pull_request` event older than the stored PR changes nothing, and a merged PR stays merged. Subscribe the GitHub App to Create, Delete, Push and Pull request ([git-integration.md](docs/git-integration.md#linking-work-to-tasks-st-84)).
- API: `GET /v1/orgs/{org}/tasks/{key}/git` → `TaskGitDto` `{ taskKey, pullRequests, branches, commits }`. SDK: `tasks.git(org, key)`. A new realtime event `task.git` announces changes.
- MCP: new tool `get_task_git`. CLI: new `spider task git [key]` (default: the current branch's task); `--json` prints the same JSON as the tool.
- Web: a Development panel on the task page; project settings list the project's repos.
- `GET …/release-candidates?release=KEY` (and `spider release candidates --release`) now leaves out tasks whose linked commits and pull requests are all outside the release's repos; tasks without git links are still listed.
- Database migration `0025_git_links` (`git_links` and `pull_requests`).

### CLI

- New `spider repo list|view|add|update|remove|attach|detach` and `spider app list|add|update|remove` (ST-92): the organization's GitHub repos, added by remote URL and attached to projects, and their apps (folder, shared packages, `date`/`semver` versioning, environments in deploy order). `repo add` and `--repo` default to the current folder's `origin` remote. MCP has `list_repos`, `get_repo`, `add_repo`, `update_repo`, `attach_repo`, `add_app` and `update_app`, returning the same JSON as `--json`.
- New `spider task duplicate [key] --of KEY [--comment "…"]` closes a task as a duplicate in one step (link, canceled status, comment); MCP has the matching `mark_duplicate` tool. `link_tasks` now refuses a `duplicates` link that would close a cycle (ST-114).
- `task view --json` adds `documents`; `project view --json` adds the project's `documents`, and its `rules` gain `projectKey`, `projectName`, `format`, `updatedAt` and `url` (the full `ProjectRulesDto`); `doc diff --json` adds `diff` (the unified text); `comment --json` and `comments --json` add `author` (the handle). Nothing was removed or renamed (ST-107).
- `task update` and other commands that fail with "not found" or "forbidden" while acting as a saved agent limited to some projects say which agent acted, how it was chosen (`--as`, `SPIDER_AGENT` or the default agent) and which projects it sees: a task in another project reads as missing to it (ST-107).
- An error response without a JSON body (a proxy page, or HTTP/2 without status text) no longer prints an empty `spider: ` line; it says which request failed with which HTTP status (ST-107).
- `spider doc publish <dir> [--project ST] [--dry-run]` creates or updates documents from a folder's `.md` files in one command (ST-119). Front matter maps a file to its document (`title`, `project`, `task`; publish writes back `id` and `version`), so a rerun updates instead of duplicating. `[[Title]]` and relative `.md` links between the files are published as `[[doc:<id>]]` links. Updates are based on the file's `version`: a document changed in the tracker since then is reported as a conflict and not overwritten (no `--force`). One line per file (`created`, `updated`, `unchanged`, `conflict`, `failed`); `--json` prints `{ dryRun, results, summary }`; exit code `1` when any file is a conflict or failed.
- `spider doc publish` no longer damages local files (ST-119 review): files are read as strict UTF-8, and one that isn't (cp1251, say) or is over 1 MB is reported `failed` and never rewritten. A file that opens with a horizontal rule (`---`, a paragraph, `---`) is no longer read as front matter; a leading BOM is ignored and kept. Symbolic links (and files outside the folder) are skipped with a warning, documents are read 8 at a time, links to a file whose document is gone stay as written with a warning, and a document created whose file can't be written is reported `created` with its id. `--json` adds top-level `warnings`.

### API

- Repos and apps (ST-92): `GET|POST /v1/orgs/{org}/repos`, `GET|PATCH|DELETE /v1/orgs/{org}/repos/{owner}/{name}`, `POST …/apps`, `PATCH|DELETE …/apps/{app}`, and `POST /v1/orgs/{org}/projects/{key}/repos` / `DELETE …/repos/{owner}/{name}` to attach and detach. SDK: `repos.*`. Web: Settings → Repos.
- Repos and apps (ST-92 review): a project-scoped agent can no longer change a repo's remote or default branch, or add, change or remove its apps, when the repo is also attached to a project outside its scope (`403`, as removing it already was). Adding a repo the organization already has but the agent can't see is still `409`, now telling it to ask an owner or admin to attach the repo to its project. An app-name conflict names the repo as `owner/name`, not the URL it was addressed by.
- GitHub App (ST-82): `GET /v1/orgs/{org}/github`, `POST …/github/install`, `POST …/github/installations/{id}/sync`, `DELETE …/github/installations/{id}`, and the `/github/setup` callback. Connecting an installation links the organization's existing repos (same `owner/name`) and adds the others. Off unless the server sets all `GITHUB_APP_*` variables (`configured: false`, `503`). Web: Settings → GitHub.
- GitHub webhooks (ST-83): `POST /webhooks/github`, signed with `GITHUB_APP_WEBHOOK_SECRET` (`401` on a bad signature, `413` over 5 MiB, `503` without the App). Each delivery is handled once. Installation, installation-repositories and repository events keep connected installations, their repos and repo renames in sync, attributed to the GitHub bot; other events are recorded and ignored for now. Database migration: `github_deliveries`.
- GitHub install flow hardening (ST-82 review, ST-137): an install link (`state`) now works once (database migration: `github_install_states`; a second `/github/setup` with the same state answers `400`), and GitHub failures are logged as one line (step, status, method and URL) so the App's client secret and OAuth codes never reach the logs.
- Actors can have `type: "integration"`: the per-organization GitHub bot (`@github`, now a reserved handle). `GET /members` leaves it out; `?all=true` includes it, so clients that switch on `type` should expect a third value.
- `POST /v1/orgs/{org}/tasks/bulk-update`: tasks in `results` carry `url`, like other task responses (ST-107).
- `GET /v1/orgs/{org}/documents/graph`: `projects` carry `url` too (ST-107).
- `POST /v1/orgs/{org}/inbox/read` takes `kinds` (ST-128): `upTo` marks only those kinds, by default the task kinds. Older CLI and channel builds, which never fetch `rules` and `document_*` items, no longer mark them read; the new CLI (`spider inbox --mark-read`), the channel and MCP `mark_inbox_read` pass every kind they list. `rules` items also drop out of the inbox once their document is no longer the project's rules (replaced, cleared, moved or deleted), and archived projects' agents aren't told about rules changes. `spider project view` shows no rules instead of failing when the rules document was just deleted.

### Plugin 0.3.12

- The `tasks` skill explains milestones and the roadmap: how to read a task's milestone, put a task in one (`update_task` with `milestone`, `spider task update --milestone`) and that the tracker moves a finished milestone to Ready to close while a person closes it (ST-96).

### Plugin 0.3.11

- The `tasks` skill shows how to open the task's pull request when the work is ready: `spider pr` (pushes and opens it, closing the task on merge), or MCP `open_pull_request` after pushing (ST-87).

### Plugin 0.3.10

- The `tasks` skill asks for a **What changed** section in handoff comments (the release changelog uses it) and shows the release owner's `spider release check`, `changelog --write` and `notes` steps (ST-95).

### Plugin 0.3.9

- The `tasks` skill says Done means finished, not shipped, and how to read a task's shipping state (`shipping`, `spider task view`), mark a task with no code, and work with releases (ST-93).

### Plugin 0.3.8

- The `tasks` skill explains document comments: feedback goes on the document (`add_document_comment` / `spider doc comment`, with `quote` for a fragment), not in task comments (ST-118).

### Plugin 0.3.7

- The `tasks` skill mentions `spider doc publish <dir>` for publishing a set of documents from local files (ST-119).

### Plugin 0.3.6

- The `tasks` skill says that MCP and CLI `--json` return the same shapes, and what a "not found" from the CLI for a task MCP can see usually means (ST-107).
