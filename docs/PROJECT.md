# Spider Tracker

An agent-first task tracker and project management tool, like Linear, where AI agents are full team members alongside people.

> Status: planning. This file holds the core idea only. Details live in the linked documents.

## Vision

Most trackers add automation to a tool built for people. Spider Tracker treats agents as members of the team from the start: they can be assigned work, carry it out, open pull requests and report back, the same way people do. People stay in control through permissions, approvals and budgets.

## Core principles

1. **Agents are actors, not integrations.** People and agents share one model for assignment, mentions, comments, permissions and history.
2. **Everything is reachable by machines.** Anything possible in the UI is also possible through the API, MCP, the CLI and webhooks.
3. **Git-native.** Tasks, branches, commits and pull requests link automatically, and repository activity moves work forward.
4. **Structured but flexible.** A small opinionated core, with custom fields defined by each organization or project.
5. **Auditable.** Every change records who made it (person or agent), when and how.
6. **Fast.** Keyboard-first and real-time, with Linear as the benchmark.

## What it includes

- **Organizations** with members (people and agents), roles and teams
- **Projects** with their own workflows, cycles and milestones
- **Tasks** with status, priority, assignees, tags, sub-tasks, relations and custom fields
- **Agents**: connect existing ones or create hosted ones, assign them tasks, follow their runs
- **Git and GitHub**: link repositories; branches and pull requests sync with tasks
- **Repos and apps**: code repositories and the products built from them
- **Documents** in Markdown and HTML, at organization, project or task level
- **Tags and custom fields** you can define, used in filters and views
- **Interfaces**: web app, public API, MCP server, CLI and webhooks

## Key decisions

- **Database:** Postgres, a relational database. It has strong multi-tenant isolation and realtime support, and custom field values are stored as JSON.
- **Frontend:** a Vite + React single-page app with TanStack Router and TanStack Query.
- **Backend:** TypeScript on Bun, with a separate API service and background workers.
- **Auth:** Better Auth. Spider Tracker is its own OAuth/OIDC provider for the CLI, MCP clients and third-party apps; `id.batele.plus` login comes later.
- **Hosting:** frontend on Cloudflare Pages, backend and database on Railway, files on Cloudflare R2. For now it runs privately at `tracker.batele.plus` / `tracker-api.batele.plus` behind Cloudflare Access.
- **Repository:** a Turborepo monorepo with `web/` for frontends, `backend/` for services and `packages/` for shared code.
- **Messaging:** Postgres handles the job queue and live updates; a dedicated message broker comes only when load requires it.

## Documentation

| Document | Covers |
|---|---|
| [features.md](./features.md) | Feature details by area |
| [data-model.md](./data-model.md) | Entities, relationships, database schema |
| [architecture.md](./architecture.md) | Tech stack, services, monorepo layout, hosting |
| [decisions.md](./decisions.md) | Technology choices and their reasoning |
| [agents.md](./agents.md) | Agent model, connectivity, runs, guardrails |
| [git-integration.md](./git-integration.md) | Git and GitHub integration |
| [interfaces.md](./interfaces.md) | API, MCP server, CLI, webhooks |
| [auth.md](./auth.md) | Authentication, OAuth/OIDC provider, tokens, scopes |
| [roadmap.md](./roadmap.md) | Delivery phases |
| [open-questions.md](./open-questions.md) | Unresolved questions |
