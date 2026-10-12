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
- **Web links (ST-115):** projects, tasks and documents in responses carry `url`, their page in the web app (`WEB_ORIGIN` + `/{org}/projects/ST`, `/{org}/tasks/ST-12`, `/{org}/docs/{id}`; `webUrls` in `@repo/core/urls`). Set by the API (lists, reads, writes, the documents graph and backlinks), so it reaches CLI `--json` output too; nested task summaries (relations, inbox) don't have it.
- **Activity source:** browser sessions record `source = ui`. API-key clients record `api` by default and may declare `X-Spider-Source: cli | mcp | api`; other values are ignored.

### Projects
- `GET|POST /v1/orgs/:org/projects[?archived=true]` — active projects, oldest first (archived ones too with `archived=true`); `{ key, name, description? }` to create one with the default workflow of each task kind (owners, admins and their agents).
- `GET|PATCH /v1/orgs/:org/projects/:key` — a project with its workflows (ST-90: `workflows: { task, release, milestone }`, each a list of statuses `{ id, kind, name, category, color, position }` in board order; `statuses` stays the `task` workflow for older clients), `archivedAt` (archived ones too) and `rulesDocumentId`; `PATCH { name?, description?, rulesDocumentId? }` (owners, admins and their agents; the key can't change, `description: null` clears it). `rulesDocumentId` (ST-111) makes one of the project's own documents (not organization-wide, not a task's: `400`) its rules for agents, `null` clears them; setting them notifies the project's agents ([agents.md](./agents.md#project-rules)).
- Workflows (ST-90; owners, admins and their agents; each answers with the project and its workflows, `DeleteStatusResponse` for a delete): `POST /v1/orgs/:org/projects/:key/statuses` `{ kind?: task|release|milestone (task), name, category, color?, position? }` → `201` adds a status (appended unless `position`, 0 = first; names are unique per workflow regardless of case, else `409`; the category can't change later). `PATCH …/statuses/:id` `{ name?, color?, position? }` renames, recolors (`null` clears) or moves it within its workflow (past the end = last). `DELETE …/statuses/:id?moveTo=<status id>` → `200 { project, movedTasks }` first moves its tasks (deleted ones too) to the end of `moveTo`'s column, `moveTo` being another status of the same workflow (`400` otherwise), setting or clearing `completedAt` when they close or reopen, then deletes it; refused (`400`) when the workflow would be left without an open status (not done or canceled) or a done status. A status of another project is `404`. Moved tasks get a `task.updated` activity entry; the project gets `project.status_created|updated|deleted`. Core: `createStatus`, `updateStatus`, `deleteStatus` (`createStatusInput`, `updateStatusInput`, `deleteStatusInput`); SDK: `projects.statuses.create|update|delete`.
- `POST|DELETE /v1/orgs/:org/projects/:key/archive` — archive (left out of lists, new tasks get `400 "Project ST is archived"`; its tasks stay readable and editable) or restore (owners, admins and their agents). Both return the project; repeating one changes nothing.

### Repos and apps
ST-92. A repo is addressed by its GitHub `owner/name` (case-insensitive). Everyone in the organization reads repos; a project-scoped agent sees only the repos attached to its projects, and only those projects in a repo's `projects`. Owners, admins and their agents manage them (as projects, ST-61); a scoped agent must attach a new repo to one of its projects and can't remove a repo other projects use.
- `GET|POST /v1/orgs/:org/repos[?project=KEY]` — repos by name, each `RepoDto` `{ id, owner, name, fullName, defaultBranch, githubInstallationId, projects: keys, apps: AppDto[], createdAt }`; `{ url, defaultBranch?, projects? }` adds one: `url` is a GitHub remote (`https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `ssh://…`) or `o/r`; other hosts are `400`, an existing remote `409`.
- `GET|PATCH|DELETE /v1/orgs/:org/repos/:owner/:name` — `PATCH { url?, defaultBranch? }` (a new remote after a rename); `DELETE` removes its apps and project links too.
- `POST /v1/orgs/:org/repos/:owner/:name/apps`, `PATCH|DELETE …/apps/:app` — `{ name, path, sharedPaths?, versioning?: date|semver (default semver), environments? }`; `AppDto` adds `id`, `repoId`, `repo` (`owner/name`) and `createdAt`. Names are lower-case and unique in the repo (`409`); paths are relative folders (`.` for the whole repo); environments are in deploy order (`[]` for a CLI).
- `POST /v1/orgs/:org/projects/:key/repos { repo }`, `DELETE /v1/orgs/:org/projects/:key/repos/:owner/:name` — attach or detach; both return the repo, and repeating one changes nothing.

### Tasks
- `GET /v1/orgs/:org/projects/:key/tasks[?kind=&status=&assignee=&tag=&tagMatch=&priority=&q=&parent=&overdue=true]` — the project's tasks (every kind) in board order. Repeat a parameter for several values (`?tag=bug&tag=ui&priority=1&priority=2`). `kind` (ST-90): only tasks of that kind; `status`: id, name or category, matched in the `kind`'s workflow, or in every workflow without `kind` (names win over categories); `assignee`: actor id or handle (deactivated ones too, so orphaned assignments can be found), `me`, `mine` or `none`; `tag`: name, case-insensitive; `priority`: `0`–`4`; `q`: text in the title, case-insensitive; `parent`: a task key, for its direct sub-tasks (an unknown or out-of-scope one is `400`); `overdue=true` (ST-91): tasks whose `targetDate` is before today (the server's UTC date) and whose status isn't in the done or canceled category. Statuses, assignees and priorities match **any** of their values; a task must carry **all** the tags, or at least one with `tagMatch=any` (`all` is the default everywhere: API, MCP, CLI and web); parameters combine with AND. A leading `@` and case are ignored in assignee handles, `me`, `mine` and `none` included; all three are reserved and can't be taken as handles. `mine` (ST-76) is "me and my agents": for a person, themselves plus every agent they own; for an agent key, its owner plus all the owner's agents (itself included); deleted agents count too. It is resolved on the server, in one subquery within the organization. A missing or out-of-scope project is `404` whether or not filters are given; the filters are checked after that, and unknown statuses, members and tags are `400` with the valid options. The filters live in `listTasks` (`taskListFilters` in `@repo/core/schemas`), shared by the API, MCP and CLI; SDK: `tasks.list(org, key, { kind, status, assignee, tags, tagMatch, priority, q, parent, overdue })`.
- Task kinds (ST-90): tasks carry `kind` (`task`, `release` or `milestone`); `POST …/tasks` takes `kind` (default `task`; it can't change later) and defaults to the first `todo` status of that kind's workflow. A task's `statusId` must be a status of its own project and kind, on create, update and bulk update (`400`, and a database constraint). MCP and the CLI create only tasks of kind `task` with their task commands; releases have their own (ST-93, below), milestones get theirs with ST-96.
- **Dates (ST-91):** tasks have optional `startDate` and `targetDate`, plain `YYYY-MM-DD` strings (no time, no time zone) or `null`. `POST …/tasks` and `PATCH /tasks/:key` take them (`null` clears; anything but a real calendar date is `400`); the start must be on or before the target, also when an update changes only one of them (`400 "The start date must be on or before the target date"`). Changes are recorded in the activity log like other fields. "Overdue" compares the target date with the server's UTC date ([data-model.md](./data-model.md#design-decisions)).
- `POST /v1/orgs/:org/tasks/bulk-update` `{ keys?, filter?, set, dryRun? }` → `200 { dryRun, summary: { changed, unchanged, failed }, results: [{ key, outcome, task, error }] }` (ST-106) — several tasks at once: `keys` (any projects) or `filter` (`{ project, …the list filters above, parent }`), not both. `set` takes `status` (id, name or category, matched in each task's own project and kind's workflow, so keys may span projects and kinds), `priority`, `assigneeIds`, `tagIds` (both replace the lists), `parentId`, `startDate` and `targetDate` (`null` clears; the order check runs per task against its stored dates); title and description change one task at a time. Each task is updated in its own transaction through the same code as `PATCH /tasks/:key`, so permissions and an agent's project scope are checked per task: a missing or out-of-scope task, or a status its project lacks, gives that task `outcome: "error"` with `{ code, message }` and the others go on. `outcome` is `changed` or `unchanged` otherwise, with the resulting task, in the order of the keys (deduplicated) or in board order for a filter. `dryRun: true` runs every update and rolls it back (no activity, notifications or events), so the outcomes are exactly what applying would do. At most `MAX_BULK_TASKS` (100) tasks: more keys, or a filter matching more, is a `400` that changes nothing; so is an empty `set`. Guests get `403`. Unexpected server errors still fail the request (`500`), possibly after earlier tasks were saved. Core: `updateTasks` (`bulkUpdateTasksInput` in `@repo/core/schemas`); SDK: `tasks.bulkUpdate(org, input)`.
- `POST /v1/orgs/:org/tasks/:key/duplicate` `{ of, comment? }` → `200` the task (ST-114) — marks a duplicate in one transaction: the `duplicates` link to `of`, the first status of category `canceled` in the workflow of the task's project and kind (a task already in a canceled status keeps it; `completedAt` is set when it closes) and a comment `Duplicate of ST-9: <title>`, followed by `comment` when given. Steps already done are skipped (an existing link, a canceled status), and the comment is added only when something changed, so a repeat changes nothing. Refused: the task itself as the original (`400`), a cycle of duplicates — the original already duplicates the task, directly or through a chain of `duplicates` links (`400`; `POST /relations` refuses such links too) —, a task already a duplicate of another task (`409`; unlink it first), and a workflow without a canceled status (`400`; the default milestone workflow has none). The original may be in any status, closed or a duplicate itself (chains are allowed). The comment goes through the usual comment rules: it notifies assignees and mentions, and counts toward an agent's 5 comments per task per minute (over it, `429` and nothing changes). Core: `markDuplicate` (`markDuplicateInput`); SDK: `tasks.markDuplicate(org, key, { of, comment })`; CLI `spider task duplicate`; MCP `mark_duplicate`; web: "Duplicate of…" on the task page.
- **Shipping (ST-93):** Done means finished, not shipped. Tasks carry `releaseId` (the release they ship in; null when in none or in one the caller can't see), `shippedAt` (when that release was marked Released; for a release, when it was), `noCode` (marked as having no code to ship; `PATCH /tasks/:key { noCode }` and bulk `set.noCode`, tasks only) and `shipping`: `{ state, release }` with `state` `not_in_release` | `in_release` | `shipped` | `no_code` and `release` `{ id, key, title, status: { id, name, category } }` (null when in none or out of the caller's scope). `shipping` is null for releases and milestones, and for tasks that aren't Done and are in no release. `shippingLabel` in `@repo/core/board` words it ("not in a release", "2026.10.14 · on staging", "shipped 2026.10.12", "no code").
- Agents are created as members, so their keys (CLI, MCP) get `403` on these writes unless the agent's role is raised to admin.

### Releases
ST-93. A release is a task of kind `release` (default workflow Planned → On staging → Release review → Released, plus Canceled); its title is its name, usually the version. It links repos and apps, a version per app in the app's versioning (`2026.10.13` for `date`, `1.4.0` for `semver`, a leading `v` dropped), and includes **Done** tasks of kind `task` from any project, one release per task. Members and their agents manage releases like other tasks (no guests); a repo must be visible to the caller and attached to one of its projects (it may be another project than the release's); a project-scoped agent sees and adds only its projects' tasks, and a release's `tasks` list only those.
- `GET|POST /v1/orgs/:org/projects/:key/releases[?status=&app=]` — the project's releases in board order (`status`: ids, names or categories of the release workflow, repeatable; `app`: an app name), each `ReleaseDto`: the release task plus `status { id, name, category }`, `repos [{ id, fullName }]`, `apps [{ appId, repo, name, versioning, environments, version }]` and `tasks [{ id, key, title, projectKey, status, completedAt, shippedAt, url }]` (by project key, then number). `POST { title, description?, statusId?, assigneeIds?, startDate?, targetDate?, repos?: ["owner/name"], apps?: [{ repo, app, version }], tasks?: keys }` → `201`; an app's repo is linked too.
- `GET|PATCH /v1/orgs/:org/releases/:key` — `PATCH { repos?, apps? }` replaces the linked repos or the apps with their versions (apps' repos stay linked). Status, title, owner and dates change through `PATCH /tasks/:key` like any task.
- `POST /v1/orgs/:org/releases/:key/tasks { tasks: keys }`, `DELETE /v1/orgs/:org/releases/:key/tasks/:taskKey` — add Done tasks (all or nothing; adding one again changes nothing; a task in another release is `409`; not Done, or not of kind `task`, `400`), or take one out. Both refuse a Released or Canceled release (`400`) and return the release.
- `GET /v1/orgs/:org/release-candidates[?project=&release=]` — Done tasks with code (not `noCode`) in no release and not shipped, most recently finished first, at most 200. `release` checks the release; once commits are linked to tasks (ST-89 step 6) it will narrow the candidates to the release's repos.
- **Marking Released** (`PATCH /tasks/:key` to a status of category `done`) needs every included task to be Done (`400` naming the others). It sets `shippedAt` on the release and on its tasks, each with an activity entry `task.shipped` `{ release, version }` ("shipped in 2026.10.13"); their status doesn't change. Moving it back out of Released undoes this (`task.unshipped`). Canceling a release takes its tasks out (`releaseId` change in their activity), and so does deleting it.
- SDK: `releases.list|get|create|update|add|remove|candidates`. The board helper `boardColumns(project, tasks, releases, { releaseColumns })` in `@repo/core/board` lays out the task columns, then one column per release status.

### Saved views
- `GET|POST /v1/orgs/:org/projects/:key/views` — the project's shared views plus the caller's own, by name; `{ name, filters?, shared?, view?: board|list }` to save one (not for guests). `filters` is `{ status?: ids, assignee?: ids | "me" | "mine" | "none", priority?: 0-4, tag?: ids, tagMatch?: "all" | "any", q?: text, overdue?: boolean }`: values within a key are OR-ed (tags per `tagMatch`), keys AND-ed. Views store `tagMatch` explicitly (`all` when left out). Views saved before `tagMatch` existed (ST-73) were applied by the web with any-tag semantics, so a stored view without it is returned as `tagMatch: "any"` when it has tags (`"all"` otherwise) and keeps selecting the same tasks. The web filters on the client and resolves `mine` from `GET /members?all=true` and each actor's `ownerId`, so deleted agents of yours count there too (ST-78).
- `PATCH|DELETE /v1/orgs/:org/projects/:key/views/:id` — the view's owner, or organization owners and admins, change or delete it (`403` for others; someone else's personal view is `404`). Views of projects outside an agent's scope are `404`.
- The web app applies filters client-side from the project's URL (`?status=&assignee=&priority=&tag=&tagMatch=any&q=&overdue=true`, by id; the "Overdue" toggle uses the same rule as the API, with the browser's UTC date; tags all by default, any with `tagMatch=any`, toggled with "Match all / any" in the tag filter) over the full task list; API, MCP and CLI clients filter on the server (see Tasks).

### Comments and inbox
- `GET|POST /v1/orgs/:org/tasks/:key/comments` — comments, oldest first; `{ body, parentId? }` to add.
- `GET /v1/orgs/:org/tasks/:key/backlinks` — documents mentioning the task, `[[ST-12]]` or a plain `ST-12` outside code (ST-101), most recently updated first, from `document_links` (kind `task`); the task's own documents are left out, and so are documents outside the caller's scope. SDK: `tasks.backlinks(org, key)`.
- `GET /v1/orgs/:org/inbox?after=&unread=true&limit=&wait=&kinds=` — the caller's notifications, oldest first. With `wait` (seconds, max 25) the request is held until an item newer than `after` arrives (checked every second until realtime, ST-13, replaces it). Items are `{ id, kind, createdAt, readAt, task, document, comment, from }`. `kinds` (comma-separated) picks `mention`, `assigned`, `comment`, `reply`, `rules`, `document_mention`, `document_reply` and `document_comment`; the default is the four task kinds, because `rules` items (ST-111: a project's rules were set or changed) and `document_*` items (ST-118: comments on documents) have `task: null` and `document: { id, title, projectKey }` (`projectKey` null for an organization-wide document), which clients from before them don't expect. The CLI and the channel ask for every kind.
- `POST /v1/orgs/:org/inbox/read` — `{ ids }` or `{ upTo }`.

### Document comments (ST-118)
Reviews and feedback on a document live on the document, not in a task's comments.
- `GET /v1/orgs/:org/documents/:id/comments` — the document's comments, oldest first: `{ id, documentId, parentId, authorId, body, quote, outdated, documentVersion, resolvedAt, resolvedBy, createdAt, editedAt }` (core `DocumentCommentDto`). Reading takes what reading the document takes (out-of-scope documents are `404`; guests can read).
- `POST /v1/orgs/:org/documents/:id/comments` — `{ body, quote?, parentId? }` → `201`. Writing follows the task comment rules: no guests (`403`), agents at most 5 comments per document per minute (`429`). `parentId` replies to any comment on the document; replies sit in their top-level comment's thread. `quote` comments on a fragment (top-level comments only; a reply with one is `400`): text as a reader sees it, which must occur in the current version (`400` otherwise). Quotes match on letters and digits only, so Markdown or HTML markup, link targets, punctuation and spacing don't count (`@repo/core/anchors`, `quoteOccursIn`). When the text changes so that the quote no longer occurs, the comment stays and reads `outdated: true`; `documentVersion` is the version it was posted on.
- `PATCH /v1/orgs/:org/documents/:id/comments/:commentId` — `{ resolved: true | false }` resolves or reopens a thread (its first comment; a reply is `400`); a repeat changes nothing. Activity `comment.resolved` / `comment.reopened` on the document.
- Notifications (inbox, and so the channel): mentioned members get `document_mention`, the author of the comment replied to `document_reply`, the document's creator and everyone else in the thread `document_comment`; one item per person (in that order of precedence), never the commenter. A scoped agent only sees items about documents it can read. Each change publishes a `document.commented` event.
- SDK: `documents.comments.list(org, id)`, `.create(org, id, { body, quote?, parentId? })`, `.resolve(org, id, commentId, resolved = true)`. Web: the document page's Comments panel; in a Markdown document, select text and press Comment to quote it; quotes of open threads are highlighted, outdated ones are struck through. HTML documents render in a sandboxed frame, so their fragments are commented on through the API, CLI or MCP and aren't highlighted.
- `GET|POST /v1/orgs/:org/documents[?project=ST|?task=ST-12]` — documents without content, most recently updated first (a project's include its tasks'; no filter lists the whole organization); `{ title, format?: md|html, content?, project?, task? }` to create (a task implies its project; neither means organization-wide). Content is capped at 1 MB.
- `GET|PATCH|DELETE /v1/orgs/:org/documents/:id` — `PATCH { baseVersion, title?, format?, content? }` saves a new version; `409 conflict` if someone saved since `baseVersion`, and an unchanged save returns the document as is.
  - **Renames rewrite links (ST-101):** a new title (not just a change of case or spacing) rewrites `[[Old title]]`, `[[Old title#Heading]]` and `[[Old title|label]]` in the documents whose link opened this one, in the same transaction: each gets one new version saved by the renamer (`document.updated` activity with `relinked: { documentId, title: [old, new] }`), keeping headings and labels; links in code stay. The link becomes `[[doc:<id>]]` instead when the new title can't be linked to (`[`, `]`, `|`, `#`, a task key) or another document has it too, and in HTML documents when it holds `<`, `&` or `>`. `[[doc:<id>]]` links need nothing. The rewrite runs with the renamer's rights: documents outside their project scope are left as they are (their links go unresolved, as before) and aren't reported; a project's rules document (ST-111) is skipped unless they can change rules (owners, admins and their agents), as is one the rewrite would take over 1 MB. The response then carries `relinked: { rewritten: [{ id, title }], skipped: [{ id, title, reason: "rules" | "too_large" }] }` (core `UpdatedDocumentDto`).
- `POST /v1/orgs/:org/documents/:id/edit` — `{ baseVersion?, edits: [...] }`: change part of a document without resending it (ST-116). Each edit is `{ old, new, all? }` (replace a fragment; it must occur exactly once unless `all: true` replaces every occurrence), `{ append }` (add text at the end, on a new line) or `{ section: "## Decisions", content }` (replace a Markdown section's body: the text under that heading up to the next heading of the same or a higher level; the heading stays; plain `"Decisions"` matches any level; headings in code blocks don't count). Edits apply in order and save one new version (`document.updated` activity with `edits: ["replace" | "append" | "section", …]`); an edit that changes nothing returns the document as is. With `baseVersion`, `409 conflict` if someone saved since; without it the edits apply to the current version under the document's row lock, so concurrent edits of different parts both land. A fragment or section that isn't there is `409 conflict` (read the document again); an ambiguous one, an empty `old`/`append`, a section edit of an HTML document or a result over 1 MB is `400 validation`. Nothing is saved when any edit fails.
- `POST /v1/orgs/:org/documents/:id/move` — `{ project: "ST" | null }`: move a document to a project, or make it organization-wide (`null`). Keeps id, versions and content (no new version; recorded as `document.moved` activity). A task document leaves its task. Needs write access and both the current and the target project in the agent's scope; moving into an archived project is `400` (creating a document there too), moving out is allowed.
- `GET /v1/orgs/:org/documents/graph` — every document the caller can see, the tasks and projects they sit in or link to (`{ key, title, projectKey, statusCategory, url }`, `{ key, name }`), and `links: [{ from, to }]` where `to` is `{ type: "document", id }`, `{ type: "task", key }` or `{ type: "unresolved", title }`. Links come from `[[Title]]`, `[[Title|label]]`, `[[doc:<id>]]` (by id, survives renames; ST-115), `[[ST-12]]` and plain task keys in the content (code excluded); tasks that don't exist or are out of scope are left out (ST-100). Each edge is listed once.
- `GET /v1/orgs/:org/documents/:id/backlinks` — documents whose `[[link]]` opens this one (by title or `[[doc:<id>]]`), most recently updated first.
- `GET /v1/orgs/:org/documents/:id/versions[/:version]` — every save is a version (newest first, without content), or one version with its content.
- `GET /v1/orgs/:org/documents/:id/diff?from=3[&to=5]` — what changed between two versions (ST-117); without `to`, against the current one. A line diff of the content (Markdown or HTML source; shortest edit script, Myers): `{ documentId, from, to, added, removed, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{ kind: "context" | "added" | "removed", text, oldLine, newLine }] }] }`, with 3 lines of context per hunk as in `diff -u`; `from` and `to` are version summaries (title, format, author, date), so a title change shows there. `from > to` diffs backwards. Readable by whoever can read the document; a missing version is `404`, a missing or non-numeric `from` `400`. The line diff itself is `@repo/core/diff` (browser-safe: `diffLines`, `diffHunks`, `formatUnifiedDiff`).

### Members and invitations
- `GET /v1/orgs/:org/members[?all=true]` — active people and agents with their roles. Every actor has `deactivated: boolean` and `ownerId` (for agents, the owning person's actor id, deleted agents too; `null` for people; ST-78); with `all=true` the list also includes deactivated people and deleted agents (`deactivated: true`), for naming past assignees, comment authors and document authors. Use the default list for pickers and mentions.
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

The server's `initialize` answer carries **instructions** with the rules of the agent's active projects (each cut at 12,000 characters, with a pointer to `get_document`), so a session has them without calling anything; Claude Code puts them in the system prompt. Without rules there are no instructions.

| Tool | What it does |
|---|---|
| `whoami` | The agent and organization the key acts as, and `projectRules`: the rules of its active projects, with content |
| `list_projects`, `get_project` | Active projects (`{ items }`); a project with its `workflows` (statuses of each task kind in board order, with categories; `statuses` is the task workflow), `rules` (`ProjectRulesDto` with `url`, or null) and its `documents` |
| `create_project`, `update_project` | Owners, admins and their agents (an agent acts with its owner's rights here; a project-scoped agent gets access to the projects it creates): key (fixed once created), name, description (null on update clears it), `rulesDocumentId` on update (null clears it) |
| `archive_project` | Owners, admins and their agents: archive a project (out of `list_projects`, no new tasks); `undo: true` restores it |
| `list_tasks` | Tasks in a project; filters: `kind` (task, release or milestone), `status` (id, name or category, in the `kind`'s workflow or every workflow; one or an array, any of them), `assignee` (`me`, `mine` — the agent's owner and all the owner's agents —, `none` or a handle, deactivated ones too; one or an array), `tags` (names; all of them, or any with `tagMatch: "any"`), `priority` (list of 0–4; any of them), `query` (title text), `overdue` (true: target date passed, not done or canceled), `limit` |
| `get_task` | One task by key, with its status, assignee handles, tag names, parent key, `subtasks`, `relations` and `documents` |
| `create_task`, `update_task` | Status by name, priority 0–4, assignees as handles or `me`, `parent` as a task key (null on update makes it top-level), `startDate` / `targetDate` as `YYYY-MM-DD` (null on update clears); `update_task` replaces the assignee list |
| `update_tasks` | Several tasks at once (ST-106): `keys` (up to 100, any projects) or `filter` (`projectKey` plus `parent`, `status`, `assignee`, `tags`, `tagMatch`, `priority`, `query`, `overdue`, as in `list_tasks`; fails if more than 100 match), and the changes as in `update_task` (`status` by name or category in each task's project and kind's workflow, `priority`, `assignees`, `tags`, `parent`, `startDate`, `targetDate`). Returns `{ dryRun, summary, results }`: per task `{ key, outcome, task, error }`, `outcome` `changed` / `unchanged` with the `task`, or `error` with `error: { code, message }`; one failing task doesn't stop the others. Applies at once; `dryRun: true` previews |
| `assign_to_me` | Adds the agent to a task's assignees |
| `start_task` | Assigns the agent and moves the task to the first in-progress status of its workflow (project and kind) |
| `create_status`, `update_status`, `delete_status` | Workflow editing (ST-90; owners, admins and their agents): add a status to a kind's workflow (`kind` default task, `name`, `category`, `color?`, `position?`), rename / recolor / move one (`status` by name or id), delete one after moving its tasks to `moveTo` (name or id, same workflow). Return the project as `get_project` does (without rules and documents); `delete_status` returns `{ project, movedTasks }` |
| `list_members` | People and agents with their handles |
| `link_tasks`, `unlink_tasks` | Links between tasks: `blocks` / `blocked_by`, `relates`, `duplicates` / `duplicated_by` (from this task's side); `get_task` lists them |
| `mark_duplicate` | `key` is a duplicate `of` another task (ST-114): links it, moves it to the first canceled status of its workflow and comments "Duplicate of KEY" (plus `comment`), in one step; returns the task as `get_task` describes it. A repeat changes nothing; self, cycles and a second original are refused |
| `list_repos`, `get_repo`, `add_repo`, `update_repo`, `attach_repo` | Repos (ST-92): `list_repos` (`project` to filter) → `{ items: RepoDto[] }`, the others a `RepoDto`; `add_repo` takes a GitHub `url` (or `owner/name`), `defaultBranch`, `projects`; `attach_repo` takes `repo`, `projectKey` and `detach: true` to remove. No delete tool: `spider repo remove` or the web |
| `add_app`, `update_app` | Apps of a repo: `name`, `path`, `sharedPaths`, `versioning` (`date` / `semver`), `environments` in deploy order; `update_app` names the app with `app` and can rename it with `name` |
| `create_release`, `get_release`, `list_releases`, `update_release`, `add_to_release`, `remove_from_release`, `list_release_candidates` | Releases (ST-93): `create_release` (`projectKey`, `title` = the version, `apps: [{ repo, app, version }]`, `repos`, `tasks`, `status`, `assignees`, `targetDate`), `update_release` (replaces `repos` or `apps`), `add_to_release` / `remove_from_release` (`key`, `tasks`); `list_release_candidates` (`projectKey`, `release`) lists Done tasks with code in no release. Status changes go through `update_task` (Released ships the tasks); `update_task` and `update_tasks` take `noCode` |
| `list_tags`, `create_tag` | Organization tags; `create_task` / `update_task` take `tags` by name (update replaces the list) |
| `list_comments`, `add_comment` | A task's comments; comment with `@handle` mentions, `parent_id` to reply |
| `list_document_comments`, `add_document_comment`, `resolve_document_comment` | A document's comments (ST-118) as `DocumentCommentView` (`{ items }`); comment with `body`, `quote` (a fragment of the current text, top-level only) and `parent_id` to reply; resolve a thread by its first comment (`resolved: false` reopens) |
| `get_inbox` | Your notifications (mention, assigned, comment, reply; `rules` with `project` and `rulesDocument`, and `document_mention` / `document_reply` / `document_comment` with `project` and `document`, instead of `task`), oldest first; `after` cursor, `unread_only` (default true), `wait_seconds` (≤ 20) |
| `mark_inbox_read` | By `ids` or `up_to` an id |
| `list_documents` | Documents (no content) of a `task`, a `project` (with its tasks') or the whole organization; `get_project` and `get_task` also list theirs |
| `get_document` | Content and `version` (the `baseVersion` for updates); `version` argument reads an older one |
| `diff_document` | What changed between versions `from` and `to` (omit `to` for the current one): a unified diff of the lines, `added`/`removed` counts, the structured `hunks`, and each side's version, title and `authorId` |
| `list_backlinks` | The documents linking to a document (`id`: `[[its title]]` or `[[doc:<id>]]`) or mentioning a task (`task`: `[[ST-12]]` or a plain key; not its own documents), most recently updated first: `{ items }` of document summaries, as `spider doc backlinks --json` (ST-101) |
| `get_document_graph` | The documents graph exactly as `GET …/documents/graph` and `spider doc graph --json`: every visible document (summary), the tasks (`key`, `title`, `projectKey`, `statusCategory`, `url`) and projects (`key`, `name`, `url`) around them, and `links: [{ from, to }]` (ST-101) |
| `move_document` | Move a document to another `project` (key) or organization-wide (`project: null`); keeps its id and versions, a task document leaves its task |
| `create_document`, `update_document` | Markdown or HTML, organization-wide or in a `project` / `task`; `update_document` replaces the whole content, needs `baseVersion` and fails if someone saved since; a new title rewrites `[[Old title]]` links elsewhere and returns `relinked` (ST-101). Links: `[[Title]]`, `[[Title|label]]`, `[[doc:<id>]]`, `[[ST-12]]` |
| `edit_document` | Change part of a document: `edits` of `{ old, new, all? }`, `{ append }` or `{ section: "## Heading", content }`, saved as one new version; `baseVersion` optional (without it, applies to the current version and fails if a fragment or section isn't there) |

Status names and handles match case-insensitively; an unknown one returns a tool error listing the valid options. Domain errors (not found, forbidden, validation) come back as tool errors (`isError`) with their message.

Tool results are JSON in the same shapes as the CLI's `--json` output; see [CLI and MCP output](#cli-and-mcp-output).

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
                          "projects": [{ "key": "ST", "name": "Spider Tracker" }], "source": "invite", "createdAt": "…",
                          "permissionMode": "auto" }
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
`spider claude [agent] [--no-channel] [--permission-mode <mode>] [-- claude args…]` picks the agent (the argument, `--as`, a picker grouped server → organization when run at a terminal with several agents saved, else `SPIDER_AGENT` or the default) and runs:

```bash
claude [claude args…] [--permission-mode <mode>] [--agent <qualified name>] --mcp-config <tmp>/mcp.json \
  --dangerously-load-development-channels server:spider-channel
```

with `SPIDER_AGENT=<server/org/handle>` set and `SPIDER_TOKEN` removed. The temporary MCP config (0600, deleted when Claude exits) holds no secret: the `spider` HTTP server at `<server>/mcp` with `headersHelper` `<this CLI> mcp-headers --as <agent> --server <server>`, and the `spider-channel` stdio server (`<this CLI> channel --as <agent>`), where `<this CLI>` is `bun <checkout>/backend/cli/src/index.ts` from source or the compiled `spider` binary. `--agent` is added when an agent file in the private plugin (`spider-agents:<server>:<org>:<name>`) or, from older versions, anywhere under `~/.claude/agents/` says `spider-agent: <agent>` in its frontmatter, or a top-level `~/.claude/agents/<handle>.md` has no `spider-agent`. The plugin's own `spider` MCP server is namespaced `plugin:spider-tracker:spider`, so it doesn't clash with the one in the temporary config. `spider agents remove <agent> --claude` deletes the linked agent files (plugin and `~/.claude/agents`) and the folders they leave empty; without it, they are listed and kept. The exit code is Claude's.

`--permission-mode` is always passed: `spider claude --permission-mode`, else the agent's saved `permissionMode` (`spider agents permission-mode <agent> [mode] [--clear]`, `--json`: `{ agent, permissionMode, effective }`), else `auto`; it is left out when the claude args already give `--permission-mode` or `--dangerously-skip-permissions`, and giving both that and the spider option is a usage error. Before starting, stderr gets `Permission mode: <mode> (<where from>)`, a note that Claude Code will ask to confirm the development channel (unless `--no-channel`), and a warning for each hook in the user's or project's Claude Code settings that runs a missing script ([agents.md](./agents.md#saved-agents-on-a-machine)).

**A team in tmux:** `spider claude <agent>… --tmux <session>` or `spider claude --all [--project <key>] [--server <name>] --tmux <session>` opens one detached tmux window per agent, named by handle, each running `<this CLI> claude <server/org/handle> [--no-channel] [--permission-mode <mode>] [-- claude args…]` (shell-quoted) in the current directory, with `SPIDER_CONFIG_DIR` passed on (`-e`, tmux 3.0+). `--all` takes every saved agent, `--project` those whose saved scope names the project (unscoped agents are left out), `--server` those on that server. Agents whose window already exists in the session are skipped, so reruns don't duplicate. `--dry-run` prints the plan (and works without tmux); otherwise a missing tmux exits 1 with an install hint. Two agents with one handle, an invalid session name (`:`, `.`, spaces) or `--all`/`--project`/`--dry-run` without `--tmux` are usage errors. Tests inject the tmux runner (`RunOptions.tmux`, `src/tmux.ts`).

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
spider agents permission-mode <agent> [mode] [--clear]   # the mode spider claude starts it in (default auto)
spider claude [agent] [--no-channel] [--permission-mode <mode>] [-- claude args…]
spider claude <agent>… | --all [--project <key>] --tmux <session> [--dry-run]   # a window per agent; running ones skipped
spider mcp-headers [--server prod]  # {"Authorization": "Bearer …"} for Claude Code's headersHelper; with --server, {} unless the key is that server's
spider whoami                       # also names the saved agent in use
spider <command> --as <agent>       # any command, as a saved agent
spider projects [--archived]
spider project create --key OPS --name "Operations" [--description …]   # owners, admins and their agents (also update/archive)
spider project view <KEY>                      # workflows with task counts, description, archived state, rules for agents
spider project status [list] <KEY> [--kind release]                    # every workflow, or one kind's (ST-90)
spider project status add <KEY> <name> --category in_review [--kind task] [--color #22c55e] [--position 0]
spider project status update <KEY> <status> [--kind task] [--name …] [--color …|""] [--position n]
spider project status delete <KEY> <status> --move-to <status> [--kind task]   # moves its tasks first
spider project update <KEY> [--name …] [--description …] [--rules <document-id>]   # the key can't change; "" clears description or rules
spider project archive <KEY> [--undo]          # archived: out of `spider projects`, no new tasks
spider task list [--project ST] [--kind task] [--status "In Progress"] [--mine] [--assignee @alice] [--tag bug --tag ui [--any-tag]] [--priority 1,2] [--overdue] [--limit 50]
spider task view [ST-12]
spider task create --project ST --title "Fix login" [--description …] [--status Todo] [--priority 0-4] [--assign @alice --assign me] [--start 2026-10-01] [--target 2026-10-31]
spider task update [ST-12] [--title …] [--description …] [--status …] [--priority …] [--assign …] [--start …] [--target …]   # --target "" clears
spider task update ST-2 ST-3 ST-7 --status Done [--priority …] [--assign …] [--tag …] [--parent …] [--dry-run]
spider task update --project ANT [--parent ANT-1] [--status todo] [--assignee …] [--tag …] [--priority …] --set-status Backlog [--set-priority …] [--set-assign …] [--set-tag …] [--set-parent …] [--set-start …] [--set-target …] [--overdue] [--yes]
spider task start [ST-12] [--no-branch]   # assign me + the first in-progress status of the task's workflow + the task's git branch
spider start [ST-12] [--no-branch]        # the same
spider task done [ST-12]    # the first done status of the task's workflow
spider task duplicate [ST-12] --of ST-9 [--comment "…"]   # link duplicates + first canceled status + a comment, in one step (ST-114)
spider tags
spider repo list [--project ST]          # repos with their apps and projects (ST-92)
spider repo view [owner/name]            # default: this folder's origin remote
spider repo add [url] [--project ST] [--default-branch main]   # a GitHub URL or owner/name; default: origin
spider repo update owner/name [--url …] [--default-branch …]
spider repo attach owner/name ST         # `repo detach` removes; `repo remove owner/name` deletes it with its apps
spider app list [--repo owner/name]
spider app add web --path web/app [--shared packages/core,packages/sdk] [--versioning date|semver] [--env staging,prod] [--repo owner/name]
spider app update web [--name …] [--path …] [--shared ""] [--versioning …] [--env ""]   # "" clears a list; `app remove web` deletes
spider release list --project ST [--status …] [--app web]   # releases (ST-93)
spider release view ST-120
spider release create --project ST --title 2026.10.13 --app web=2026.10.13 --app cli=0.1.8 [--repo owner/name] [--task ST-90,ST-91]
                                                 # --app takes owner/name:app=version; default repo: the only --repo, else origin
spider release update ST-120 [--app …] [--repo …]   # replaces the apps or repos
spider release add ST-120 ST-90 OPS-7           # Done tasks, any project; `release remove` takes them out
spider release candidates [--project ST]        # Done tasks with code in no release
spider task update ST-120 --status "On staging"  # a release moves like a task; `task done ST-120` marks it Released and ships its tasks
spider task update ST-89 --no-code              # Done, nothing to ship (--code undoes)
spider task create … [--tag bug --tag agent]   # also on update (replaces; --tag "" clears)
spider link ST-1 blocks ST-2                     # blocked-by, relates, duplicates, duplicated-by; `spider unlink` removes
spider task create … --parent ST-3              # a sub-task; on update --parent "" makes it top-level
spider comment [ST-12] "text with @mentions"
spider comments [ST-12]
spider inbox [--all] [--wait 25] [--mark-read]
spider doc list [--project ST] [--task ST-12]
spider doc view <id> [--rev 3]                 # --rev: an older version
spider doc diff <id> --from 3 [--to 5]         # unified diff; without --to, against the current version; --json: hunks of changed lines plus the unified `diff` text
spider doc backlinks <id | ST-12>              # documents linking to a document, or mentioning a task (ST-101)
spider doc graph [--json]                      # documents, tasks, projects and links; text: one "from -> to" line per link
spider doc create --title … [--project ST | --task ST-12] [--format md|html] [--file spec.md | --file -]
spider doc edit <id> --base-version 2 [--title …] [--format …] [--file … | --file -]   # or --force; a new --title updates [[links]] to it
spider doc edit <id> --old "text" --new "replacement" [--all]   # partial edits: no --force needed
spider doc edit <id> --append (--text "…" | --file …)
spider doc edit <id> --section "## Decisions" (--text "…" | --file …)
spider doc move <id> --project ST | --org      # to another project or organization-wide; keeps id and versions
spider doc publish <dir> [--project ST] [--dry-run]   # create or update documents from a folder's .md files (ST-119)
spider doc comment <id> "text" [--quote "fragment"] [--reply-to <commentId>] [--file … | --file -]   # ST-118
spider doc comments <id>                       # threads with quotes, (outdated) and (resolved by @…) marks
spider doc resolve <id> <commentId> [--reopen]
spider channel              # Claude Code channel over stdio (see agents.md)
```

- **Task key from git:** an omitted key is taken from the current branch name (`st-12-fix`, `feat/ST-12` → `ST-12`).
- **`start` and git:** after starting the task, `spider start` switches to the branch `st-12-short-title` (`branchNameFor` in `@repo/core/git`; see [git-integration.md](./git-integration.md#branch-names)), creating it if it doesn't exist: a branch that exists only on `origin` is checked out as a local branch tracking `origin/<name>`, otherwise the new branch starts from `HEAD`. The human-readable output names the directory and the branch it switched from and to. It leaves git alone outside a repository, with `--no-branch`, or when the current branch already contains the key. Uncommitted changes print a warning on stderr and come along; a failed switch is a warning too, never a failure. `--json` adds `branch`: the branch now checked out, or null when git was skipped or failed.
- **`task list` filters** run on the server: `--assignee` (handles, deactivated ones too, `me`, `mine` or `none`; `--mine` is `--assignee me`, while `--assignee mine` adds the owner and their agents) and `--priority` (numbers or names) match any of their values, `--tag` requires all the tags (any of them with `--any-tag`); all are repeatable or comma-separated. The CLI re-applies the filters to the response, so a server from before ST-50 that ignores them still yields only matching tasks. For that re-check `mine` becomes ids: the caller's person and their agents, deleted ones included, from the actors' `ownerId` (`members?all=true`; ST-78); a server from before ST-76 rejects `mine` as an unknown member.
- **Dates** (ST-91): `--start` and `--target` take `YYYY-MM-DD` (checked before the request; `""` clears) on `task create` and `task update`, `--set-start` / `--set-target` with several keys or `--project`. `task view` prints `Start: … · Target: …`, with `(overdue)` when the target date has passed (UTC) and the task isn't done or canceled; `task list` rows show `due YYYY-MM-DD` after the title. `task list --overdue` (and `--overdue` as a selector in `task update --project`) keeps only overdue tasks; the CLI re-checks it on the response, so a server without dates yields no tasks rather than all of them.
- **Bulk `task update`** (ST-106; `POST /tasks/bulk-update`): with several keys it changes them all at once; with `--project` it changes the project's tasks matching the filters. In that filter mode `--status`, `--parent`, `--tag` (with `--any-tag`), `--priority` (comma-separated for several) and `--assignee` **select** tasks, as in `task list`, and changes are given only with `--set-status`, `--set-priority`, `--set-assign`, `--set-tag` and `--set-parent` (`--assign`, `--title` and `--description` are refused there, to avoid mixing the two meanings). Without `--project` the `--set-*` flags are plain aliases (`--status` and `--set-status` both set it; passing both is a usage error), so `spider task update ST-12 --status Done` keeps working and scripts can use `--set-*` everywhere. A filter update only previews (`Dry run: …; nothing was changed`) until `--yes`; keys apply at once unless `--dry-run`. Output: one line per task (`changed` / `unchanged` / `failed` with the reason, or `would change` in a preview) and the counts; `--json` prints the API response with each `task` as a CLI `Task`. The exit code is `1` when any task failed, even though the others were saved. `--title` and `--description` take one key.
- **Statuses** match by name, then by category (`in_progress`), case-insensitively. **Assignees** are handles (with or without `@`) or `me`; `--assign` is repeatable or comma-separated and replaces the list on `update`. **Priority:** `0`–`4` or `none`, `urgent`, `high`, `medium`, `low`. `--description ""` clears it.
- **Output:** one compact line per task by default. `--json` (every command) prints one line of JSON: `whoami` → `{ actor, organization, agent }` (`agent`: the saved agent's `server/org/handle`, or null for `SPIDER_TOKEN`); `agents` → `{ default, items }`; `projects` → `{ items: Project[] }`; `project create|update|archive` and `project status add|update` → the project with its `statuses` and `workflows`, `project status delete` → `{ project, movedTasks }`, `project status list` → `{ items: Status[] }`, `project view` → the project with `taskCount` on each status (in `statuses` and `workflows`), `rules` (`ProjectRulesDto` with `url`, or null) and the project's `documents`; `task list` → `{ items: Task[] }`; `task view` → `Task` with `subtasks: Task[]`, `relations` and `documents`; other task commands → `Task` (`start` adds `branch`); `comments` → `{ items: Comment[] }`, `comment` → `Comment`; `doc comments` → `{ items: DocumentComment[] }`, `doc comment` and `doc resolve` → `DocumentComment`. Tasks, documents, comments and projects have the same shapes as in MCP ([CLI and MCP output](#cli-and-mcp-output)).
- **Errors** go to stderr (`spider: …`, or `{ "error": { "code", "message" } }` with `--json`) and always have a message: an error response without a JSON body (a proxy page, HTTP/2 without status text) reads `GET /v1/… failed with HTTP 502`. A "not found" or "forbidden" while acting as a saved agent limited to some projects names the agent, how it was chosen and its projects, e.g. `Project ANT not found (acting as prod/batele/st-developer, the default agent, which sees only ST; pass --as <agent> to act as another)`: a task in another project reads as missing to such an agent (ST-107). **Exit codes:** `0` ok, `1` unexpected, `2` usage/validation, `3` not found, `4` auth/permission (not signed in, denied or expired login). `run` never prompts; only the bin passes the `spider claude` picker, and only when stdin and stdout are terminals.
- **Documents:** `doc view` prints the document's web `url` (also in every `--json` document, task and project). `doc create --help` and `doc edit --help` list the link syntax: `[[Title]]`, `[[Title|label]]`, `[[doc:<id>]]` (by id: survives renames, shows the current title) and `[[ST-12]]`. `--file -` reads standard input; `.html` files default to `--format html`. `doc edit` needs `--base-version <n>`, the version the edit is based on (printed by `doc view` and `doc list`): if someone saved a newer version, it fails with exit code `2` (`conflict`) instead of overwriting it. `--force` instead saves on top of whatever is current. Partial edits (`--old/--new [--all]`, `--append`, `--section <heading>`, with `--text` or `--file` for the latter two) send only the change (`POST …/documents/:id/edit`) and need neither: without `--base-version` they apply to the current version and fail with exit code `2` (`conflict`) if the fragment or section isn't there. One partial edit per call; `--title`/`--format` go in a separate `doc edit`.
- **Publishing a folder** (`doc publish <dir>`, ST-119): every `.md` file under `<dir>` (sub-folders too; hidden files and folders and `node_modules` are skipped) is one Markdown document. The mapping lives in each file's **front matter**, not a separate manifest: `title` (default: the file name without `.md`), `project` or `task` (only used when creating; default `--project`, else organization-wide), and `id` and `version`, which publish writes back: `id` right after creating the document, `version` after every save (the version the file now matches). Other front matter lines are kept and not published; the content is what follows the front matter. Links between the files, `[[Title]]` (a file's title, else its file name; `#heading` and `|label` kept) and relative Markdown links `[text](../other.md#heading)` (the text becomes the label), are published as `[[doc:<id>]]` links, which survive renames; the files keep them as written. Links in code, to tasks, by id and to titles outside the folder are published as written; a relative `.md` link outside the folder or a title two files share is a warning. Steps: read the documents the files already have, create the missing ones (with the links that resolve so far), then save content, so new documents that link to each other get a second version with the links. Each update is based on the file's `version` (`PATCH` with `baseVersion`): when the document is already the same (title, content, `md`) the file is `unchanged` (and a newer `version` is recorded); when it changed in the tracker since the file's version, or the file has an `id` but no `version`, it is a `conflict` and nothing is saved: merge the change (`doc diff <id> --from <version>`), set `version` to the current one and publish again. Output: one line per file (`created`, `updated`, `unchanged`, `conflict` with the reason, `failed`; `would create`/`would update` with `--dry-run`, which saves nothing and writes no file) and the counts; `--json` prints `{ dryRun, results: [{ file, status, id, title, version, url?, message?, warnings? }], summary: { created, updated, unchanged, conflict, failed } }`. Exit code `1` when any file is a conflict or failed; `2` for a missing folder, an invalid `id` or `version`, or two files with the same `id`. Code: `backend/cli/src/publish.ts`.
- Code: `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd?, openUrl?, sleep?, stdin?, select?, spawn?, git?, self? })`; `git` runs git commands (default: the real `git`; tests inject a fake); `src/index.ts` is the bin. Tests call `run` against the Hono app through `fetch`.

### CLI and MCP output

Since ST-107 the CLI (`--json`) and the MCP tools print tasks, documents, comments and projects in the same shapes, built from the DTOs in `@repo/core/contracts` by `@repo/core/views` (`taskView`, `commentView`, `documentCommentView`, `documentVersionView`, `documentDiffView`, `projectRulesView`), so a script can switch between them. A test in `backend/cli/src/integration.test.ts` compares the two value for value.

| Entity | Shape | CLI | MCP |
|---|---|---|---|
| Task | `TaskDto` (`id`, `key`, `kind`, `priority` 0–4, `statusId`, `parentKey`, `startDate`, `targetDate`, `assigneeIds`, `tagIds`, `subtasks: { done, total }`, `url`, …) plus `status: { id, name, category }`, `assignees` (handles; `"x (deactivated)"`) and `tags` (names) | `task create/update/start/done` | `create_task`, `update_task`, `assign_to_me`, `start_task` |
| Task detail | Task with `subtasks: Task[]` (instead of the counts), `relations: [{ kind, task, title }]`, `documents: DocumentSummary[]` | `task view` | `get_task` |
| Task list | `{ items: Task[] }` | `task list` | `list_tasks` (adds `total`) |
| Bulk update | `{ dryRun, summary, results: [{ key, outcome, task: Task \| null, error: { code, message } \| null }] }` | `task update` with several keys or `--project` | `update_tasks` |
| Document | `DocumentDto` (`projectKey`, `taskKey`, `version`, `authorId`, `content`, `url`, …; a save that renamed it adds `relinked: { rewritten, skipped }`); lists without `content` | `doc create/view/edit/move`, `doc list` → `{ items }` | `create_document`, `get_document`, `update_document`, `edit_document`, `move_document`, `list_documents` → `{ items }` |
| Old document version | `DocumentVersionDto` plus `id`, `projectKey`, `taskKey`, `currentVersion`, `url` | `doc view --rev` | `get_document` with `version` |
| Document diff | `DocumentDiffDto` (`documentId`, `from`, `to`, `added`, `removed`, `hunks`) plus `diff`, the unified text (`--- v1` / `+++ v2`) | `doc diff` | `diff_document` |
| Project rules | `ProjectRulesDto` (`projectKey`, `projectName`, `documentId`, `title`, `format`, `version`, `updatedAt`, `content`) plus `url` | `rules` in `project view` | `rules` in `get_project`, `projectRules` in `whoami` |
| Backlinks | `{ items: DocumentSummary[] }` | `doc backlinks <id \| ST-12>` | `list_backlinks` |
| Documents graph | `DocumentGraphDto` with `url` on documents, tasks and projects | `doc graph` | `get_document_graph` |
| Comment | `CommentDto` plus `author` (handle) | `comment`, `comments` → `{ items }` | `add_comment`, `list_comments` → `{ items }` |
| Document comment | `DocumentCommentDto` plus `author` and `resolver` (handles; `resolver` null when open) | `doc comment`, `doc resolve`, `doc comments` → `{ items }` | `add_document_comment`, `resolve_document_comment`, `list_document_comments` → `{ items }` |
| Repo | `RepoDto` (`fullName`, `defaultBranch`, `projects`, `apps: AppDto[]`, …); no `url` | `repo list` → `{ items }`, `repo view/add/update/attach/detach` | `list_repos` → `{ items }`, `get_repo`, `add_repo`, `update_repo`, `attach_repo` |
| App | `AppDto` (`repo`, `name`, `path`, `sharedPaths`, `versioning`, `environments`, …) | `app add/update`, `app list` → `{ items }` | `add_app`, `update_app` |
| Release | `ReleaseView` (`releaseView`): `ReleaseDto` (`status`, `repos`, `apps`, `tasks` with `url`, `url`) plus `assignees` and `tags` | `release view/create/update/add/remove`, `release list` → `{ items }` | `get_release`, `create_release`, `update_release`, `add_to_release`, `remove_from_release`, `list_releases` → `{ items }` |
| Release candidates | `{ items: Task[] }` | `release candidates` | `list_release_candidates` |
| Project | `ProjectDto` (`archivedAt`, `url`, …); `ProjectDetailDto` adds `statuses` (the task workflow) and `workflows` (every kind's) and, for a read, `documents` | `projects` → `{ items }`, `project create/update/archive/view` | `list_projects` → `{ items }`, `create_project`, `update_project`, `archive_project`, `get_project` |

Differences that remain:
- `list_tasks` adds `total` (the matches before `limit`); the CLI's `task list` can span projects and doesn't count.
- `project view` adds `taskCount` to each status (in `statuses` and `workflows`); `get_project` doesn't count tasks.
- CLI-only fields: `branch` on `start`, `agent` on `whoami`.
- Not unified yet (different shapes): `whoami` (MCP `{ organization: { slug, name }, you: { handle, name, role }, projectRules }`), the inbox (MCP items flatten `task`, `title` and `from` to keys and handles), task activity (MCP names statuses and assignees), tags and members (MCP returns bare arrays with fewer fields: `{ name, color }`, `{ handle, name, type, role }`; the CLI `{ items }` of the DTOs), and links (`link`/`unlink` vs `link_tasks`/`unlink_tasks`).

Before ST-107, MCP returned its own shapes; the changes are listed in [CHANGELOG.md](../CHANGELOG.md).

### Planned
- Keys in the OS keychain instead of a file, per-repo defaults in `.spider.json`
- `spider pr`
- `spider agent list|run|logs`, `spider doc pull` (local files from documents; `doc publish` covers the other way), `--field` filters
- Filtering by tag group (e.g. "any tag in group Area") once tag groups exist
- Distribution through npm and standalone binaries for Homebrew and curl installs
- Local SQLite cache for instant reads and offline use; `spider tui` (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
