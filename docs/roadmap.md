# Roadmap

[← Project overview](./PROJECT.md)

## Phase 0: Foundations
- Monorepo setup (done: Turborepo + Bun)
- `packages/db` (Drizzle schema + migrations), `packages/core`
- Auth (Better Auth: social sign-in, magic link, sessions), organizations, members, roles
- Core schema: projects, statuses, tasks, tags

## Phase 1: Core tracker
- Task create/edit/delete, list and board views, filters
- Comments and activity log
- Keyboard shortcuts and command palette
- Public API, API keys, `packages/sdk`
- OAuth/OIDC provider + device flow (for the CLI and MCP)

## Phase 2: Agents
- External agents as actors
- MCP server
- Assigning tasks to agents, agent runs, run logs
- Guardrails: permissions, budgets, approvals

## Phase 3: Git and GitHub
- GitHub App, repository linking
- Automatic task ↔ branch/commit/pull request linking
- Status automation, pull request state on tasks
- Agents opening pull requests

## Phase 4: Documents and custom fields
- Markdown/HTML documents with version history
- Custom field definitions, used in views and filters
- Apps

## Phase 5: Polish and scale
- Hosted agents (created in the app)
- Cycles, milestones, timeline view
- Notifications, inbox, outbound webhooks
- CLI
- Claude Code plugin (MCP + skill + channel)
- Optional GitHub Issues sync
- Sign in with `id.batele.plus`
