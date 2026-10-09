# Roadmap

[← Project overview](./PROJECT.md)

Ordered so the product is used to build itself as early as possible: by the end of Phase 2, Spider Tracker tracks its own development and Claude Code works on its tasks through MCP.

---

## Phase 0: Foundations and deployment (in progress)

**Goal:** an empty app, deployed privately, end to end.

- [x] Monorepo: Turborepo + Bun, shared lint and TypeScript configs
- [x] Design docs
- [x] `packages/db` (Drizzle schema + migrations), `packages/core`
- [x] `backend/api` (Hono) with a health check, `web/app` (Vite + TanStack Router + Query) shell
- [x] Auth: Better Auth (magic link, GitHub, Batele ID), organizations with owner actor, onboarding (pulled forward from Phase 1)
- [x] Railway: api + Postgres 18 at `tracker-api.batele.plus`; no Railway public URL
- [x] Cloudflare Pages at `tracker.batele.plus`, DNS for both domains
- [ ] Cloudflare Access for both domains
- [x] Manual deploy script for the web app (`bun run deploy:web`); no CI/CD for now

**Done when:** a page on `tracker.batele.plus` loads data from `tracker-api.batele.plus`, behind Access.

---

## Phase 1: Core tracker

**Goal:** usable as a personal task tracker.

- Invitations, members list, roles management
- Projects, statuses, tasks (`SPI-123`), priority, assignees, sub-tasks, relations, tags
- List and board views, filters, saved views
- Comments and activity log
- Realtime: LISTEN/NOTIFY → SSE → TanStack Query
- Keyboard shortcuts and command palette

**Done when:** this project's own roadmap is tracked in Spider Tracker instead of this file.

---

## Phase 2: Agent access (dogfooding)

**Goal:** external agents work on tasks.

- Public REST API with OpenAPI spec, `packages/sdk`
- Agent actors and API keys (`spt_…`)
- MCP server at `tracker-api.batele.plus/mcp` (reached with an API key + Access service token)
- First version of the `spider` CLI: `task list/view/update`, `comment`, `start`, `--json`
- Activity records `source` (ui / api / mcp / cli)

**Done when:** Claude Code picks up a task over MCP, comments on progress and moves it to review.

---

## Phase 3: Git and GitHub

**Goal:** code and tasks stay in sync without manual updates.

- GitHub App, repository linking, repos attached to projects
- Automatic task ↔ branch / commit / pull request linking by task key
- Status automation from pull request events
- Pull request state, checks and reviews shown on the task
- CLI: `spider start` creates the branch, `spider pr` opens the pull request

**Done when:** opening and merging a pull request moves its task to review and then done, with no manual step.

---

## Phase 4: Hosted agents

**Goal:** agents run inside Spider Tracker, triggered by assignment.

- `backend/worker` with a Postgres job queue
- Agent runs via the Claude Agent SDK: triggers, run lifecycle, streamed events in the task
- Chat with a running agent; approval requests as buttons
- Guardrails: scoped permissions, budgets, approval gates, kill switch
- Sandbox for running code (provider to be decided)
- Agents opening pull requests

**Done when:** assigning a task to a hosted agent produces a reviewed pull request linked to the task.

---

## Phase 5: Documents, custom fields and apps

**Goal:** the flexible parts of the model.

- Markdown/HTML documents with version history; agents read and write them
- Custom field definitions (organization and project scope), used in views, filters and agent context
- File uploads to R2
- Apps linked to repos and projects

**Done when:** a project can define its own fields and a spec document that an agent uses while working.

---

## Phase 6: Polish and opening up

**Goal:** ready for people other than the owner.

- OAuth 2.1 / OIDC provider + device flow (CLI login, MCP clients without API keys, third-party apps)
- Cycles, milestones, timeline view
- Notifications, inbox, outbound webhooks
- Claude Code plugin (MCP + skill + channel)
- Optional GitHub Issues sync
- Remove Cloudflare Access to go public
