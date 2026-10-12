# Features

[← Project overview](./PROJECT.md)

## Tasks and projects

- Create, edit and delete tasks with readable keys (`SPI-123`)
- Statuses that each project can customise, mapped to fixed categories: backlog, todo, in progress, in review, done, canceled
- Priority, estimate, due date, sub-tasks
- Relations: blocks / blocked by, relates to, duplicates
- Several assignees per task, which can be people or agents
- Views: list, board (kanban), timeline, calendar
- Filters (status, assignee, priority, tag, title text) on the board and list, kept in the page URL so links are shareable; saved views per project, personal or shared with everyone who sees the project; the same filters (tags by name, all required) on the API, MCP `list_tasks` and `spider task list`, where the assignee filter also finds tasks still assigned to deactivated members; "Me and my agents" (`assignee=mine`) shows the tasks of a person and every agent they own (from an agent: its owner and the owner's agents), savable in views
- Grouping and sorting on any field, including custom fields
- Milestones and cycles (sprints)
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

- GitHub App per organization
- Branches, commits and pull requests link to tasks automatically
- Status changes driven by pull request events
- Agents can open pull requests

## Documents

- Markdown and HTML documents at organization, project or task level
- A project page lists its docs (with its tasks'); the documents page filters by project; documents move between projects or to the organization, keeping their history (a task document leaves its task)
- Rich editor with a Markdown source toggle and live HTML preview
- Version history and diffs
- Mentions of tasks, actors and other documents
- Agents can read and write documents (specs, reports, plans)

## Organizations, repos and apps

- Multi-tenant organizations with members, teams and roles (`owner`, `admin`, `member`, `guest`)
- Repos are linked once per organization and attached to projects
- Apps model deployable products and link to repos and projects, so you can see tasks per app

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
