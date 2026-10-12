# Features

[← Project overview](./PROJECT.md)

## Tasks and projects

- Create, edit and delete tasks with readable keys (`SPI-123`)
- Statuses that each project can customise, mapped to fixed categories: backlog, todo, in progress, in review, done, canceled
- Task kinds (ST-90): `task`, `release` and `milestone`, each with its own workflow per project (defaults: Backlog → Todo → In Progress → In Review → Done / Canceled; Planned → On staging → Release review → Released / Canceled; Planned → Active → Ready to close → Done). Owners, admins and their agents add, rename, recolor, reorder and delete statuses on Settings → Projects → Workflows, through the API, MCP (`create_status`, `update_status`, `delete_status`) and `spider project status`. Deleting a status moves its tasks to another status of the same workflow first; every workflow keeps an open and a done status. The board and list show tasks of kind `task`; releases appear in their own board columns and view (ST-93), milestones on the Roadmap (ST-96)
- Milestones and the project Roadmap (ST-96): a milestone (a task of kind `milestone`, Planned → Active → Ready to close → Done) has a goal and "Done when" in its description and start and target dates; several can be Active at once. Tasks join one of their project's milestones from the task page (Milestone field), `spider task update --milestone` or MCP `update_task`; their sub-tasks inherit it. Its progress is Done tasks out of all its tasks (canceled ones left out) and, of the Done tasks with code, how many have shipped. When every task is Done and all their code has shipped, the tracker (the `@spider` bot) moves the milestone to Ready to close; a person closes it. The Roadmap view of a project lists its milestones by date with progress bars, target date, the releases that moved them forward and their tasks; "New milestone" creates one. API, MCP (`list_milestones`, `get_milestone`, `create_milestone`) and `spider roadmap` / `spider milestone …`. The phases of `docs/roadmap.md` move into ST milestones with `bun run roadmap:import` (once)
- Deployments (ST-94): a release records each deploy of its apps, one per app and environment (commit, who, when), with `spider release deploy ST-120 --app web --env staging` (the commit defaults to HEAD), MCP `record_deployment`, or the deploy scripts: `bun run deploy:web -- --env staging --release ST-120` deploys and records it, and without `--release` they deploy as before. The first deployment moves a Planned release to On staging (the `@spider` bot). Moving it to Released stays a person's or the release owner's step, allowed once every app with environments is deployed to its last one (prod); apps without environments, like the CLI, are exempt; nothing moves a release backwards. The release page lists the latest deployment per app and environment and what Released still waits for. Deploys stay manual; staging setup is a checklist in [deployment.md](./deployment.md#staging)
- Release changelog and git check (ST-95): a release's changelog is generated from its tasks, each task's title plus the "What changed" part of its handoff note (the latest comment with a "What changed" section by an assignee), with a section per app. `spider release changelog ST-120 --write` (MCP `get_release_changelog` with `write`) saves it into the release's description, where it stays editable: regenerating replaces only the changelog block and refuses to overwrite hand edits unless forced. `spider release notes` prints it for an app's GitHub release (`--app cli`) or appends it to `CHANGELOG.md` (`--append`), and `bun run release:cli --release ST-120` uses it as the CLI's release notes. `spider release check ST-120` compares the commits since each app's previous tag (task keys from commit messages and merged branches, files mapped to app folders) with the release: candidates left out, included tasks with no commits, and apps changed but not in the release
- Releases (ST-93): Done means finished, not shipped. A release (a task of kind `release`, named by its version) links repos and apps with a version each and includes Done tasks from any project, one release per task. Marking it Released ships them: each gets "shipped in <version>" and a ship time, its status stays Done. The board shows release columns after the task columns (one per release status, on by default, "Release columns" toggle), release cards with their apps and tasks, and on every Done card its shipping state (not in a release / `<version> · on staging` / `shipped <version>` / no code); drag a Done task onto a release card to add it. The Releases view lists releases in flight and, below, the shipped ones as the changelog, filterable by app. A Done task with nothing to ship is marked "no code". API, MCP (`create_release`, `add_to_release`, `list_release_candidates`, …) and `spider release …`
- Priority, estimate, due date, sub-tasks
- Relations: blocks / blocked by, relates to, duplicates; marking a duplicate (link, cancel, comment) is one action in the web, CLI and MCP
- Several assignees per task, which can be people or agents
- Views: list, board (kanban), timeline, calendar
- Filters (status, assignee, priority, tag, title text) on the board and list, kept in the page URL so links are shareable; saved views per project, personal or shared with everyone who sees the project; the same filters (tags by name, all required) on the API, MCP `list_tasks` and `spider task list`, where the assignee filter also finds tasks still assigned to deactivated members; "Me and my agents" (`assignee=mine`) shows the tasks of a person and every agent they own (from an agent: its owner and the owner's agents), savable in views
- Grouping and sorting on any field, including custom fields
- Cycles (sprints); milestones are on the Roadmap (ST-96)
- Bulk edits, command palette (`⌘K`), keyboard shortcuts everywhere
- Real-time updates and optimistic UI
- Dark theme with a System / Light / Dark switch in the organization menu (follows the system by default)

## Agents

See [agents.md](./agents.md).

- Connect external agents (Claude Code, custom bots, CI) with an API token or MCP
- Create hosted agents in the app: model, system prompt, tools, repo access, limits
- Assigning or mentioning an agent starts an agent run
- Run progress streams into the task
- Guardrails: scoped permissions, budgets, approval gates, a kill switch

## Git and GitHub

See [git-integration.md](./git-integration.md).

- GitHub App per organization (ST-82): owners and admins connect it in Settings → GitHub; the repos it grants are linked to the organization's repos or added, and git-driven changes are attributed to a GitHub bot
- Branches, commits and pull requests link to tasks automatically (ST-84): a branch named after the task, commits that mention its key, pull requests that name it in their branch, title or body, in repos attached to its project. The task page's Development panel lists them with PR state (open, draft, closed, merged); `spider task git` and MCP `get_task_git` give agents the same
- Status changes driven by pull request events (ST-85): a linked pull request opened or ready moves its task to In Review, a draft to In Progress, a merge to Done; closed without merging changes nothing. Per project (on by default; each event's target category or none, in project settings, `spider project update --automation/--on-*` or MCP `update_project`); forward only, ordinary tasks only, and only for PRs that name the task by branch, title or closing keyword
- Opening the pull request from the tracker (ST-87): `spider pr` pushes the task's branch and opens its PR on GitHub as the App, titled after the task and closing it, linked at once; MCP `open_pull_request` does the same for a branch already pushed
- Agents can open pull requests

## Documents

- Markdown and HTML documents at organization, project or task level
- A project page lists its docs (with its tasks'); the documents page filters by project; documents move between projects or to the organization, keeping their history (a task document leaves its task)
- Rich editor with a Markdown source toggle and live HTML preview
- Version history and diffs (ST-117): line-by-line comparison of any two versions in the history panel (compare icon per version, "Compare with current" on an older one, pickers for both ends), `spider doc diff`, MCP `diff_document` and `GET …/documents/:id/diff`, so you can check what an agent changed
- Mentions of tasks, actors and other documents
- Obsidian-style links (ST-100): `[[Title]]`, `[[Title|label]]`, `[[doc:<id>]]` (by id: survives renames and shows the document's current title, ST-115) and `[[ST-12]]` (typing `[[` suggests documents; plain task keys count as mentions); "Linked from" backlinks on each document; opening a missing title creates it. A title containing `[`, `]`, `|` or `#` (or one that reads as a task key) can't be linked to by title: the `[[` suggestions leave it out; link it with `[[doc:<id>]]`
- Renaming a document rewrites `[[Old title]]` and `[[Old title|label]]` in the documents linking to it, as Obsidian does (ST-101): one new version each, saved by the renamer, and only in documents the renamer can edit (others are listed as skipped); the save toast, `spider doc edit` and MCP `update_document` say what was updated
- "Mentioned in documents" on task pages: documents linking with `[[ST-12]]` or mentioning a plain ST-12 (ST-101)
- `spider doc backlinks <id | ST-12>`, `spider doc graph --json`, MCP `list_backlinks` and `get_document_graph`, so agents can follow the knowledge base (ST-101)
- Graph view (`/docs/graph`): documents, their tasks and projects, and links as a force-directed graph; zoom, pan, drag, hover to light up neighbours, click to open; toggle tasks, projects, unresolved titles and orphans
- Agents can read and write documents (specs, reports, plans)
- Comments on documents (ST-118): on the whole document or on a fragment (select text in a Markdown document and press Comment; the quote is highlighted in the text), with replies, @-mentions and a "Resolve" mark per thread. If the quoted text changes, the comment stays and is marked "Outdated". The document's author, mentioned people and the thread get inbox (and channel) notifications. Agents use MCP `add_document_comment` / `list_document_comments` / `resolve_document_comment` or `spider doc comment|comments|resolve`
- Partial edits (ST-116; API, MCP `edit_document`, `spider doc edit --old/--new | --append | --section`): replace a fragment, append, or replace a Markdown section by its heading, sending only the change. Each saves a new version; without a base version an edit applies to the current one and fails if its fragment or section is gone, so it never overwrites someone else's save

## Organizations, repos and apps

- Multi-tenant organizations with members, teams and roles (`owner`, `admin`, `member`, `guest`)
- Repos are added once per organization by their GitHub remote URL (no GitHub App needed; ST-92) and attached to projects (a repo can serve several)
- Apps are the deployable parts of a repo (e.g. web, api, cli): a folder, the shared packages they depend on, versioning (`date` or `semver`) and environments in deploy order (e.g. staging → prod, none for a CLI); releases (ST-93) version and ship them
- Owners, admins and their agents manage repos and apps (API, MCP, `spider repo` / `spider app`, Settings → Repos); everyone reads them

## Tags and custom fields

- Organization-wide tags with colours and optional groups
- Custom fields defined at organization or project scope, for tasks, projects or documents
- Field types: text, long text (Markdown), number, currency, date, datetime, boolean, select, multi-select, URL, email, actor, task reference, repo reference, app reference; formula fields later
- Required or optional, default values and validation
- Usable in filters, views, sorting, grouping, the API and agent context

## Collaboration and notifications

- Threaded comments with reactions and mentions
- Inbox and notifications through in-app, email and webhooks
- Subscriptions to tasks and projects
- Activity feed per task, project and actor
