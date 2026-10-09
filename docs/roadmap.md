# Roadmap

[← Project overview](./PROJECT.md)

> Work items now live in Spider Tracker itself: project **ST** at https://tracker.batele.plus/batele/projects/ST. This file keeps only the phase overview.

Agent tools come before most tracker features, so agents help build the product from early on: once Phase 2 is done, Claude Code works on Spider Tracker's own tasks through the API and MCP, and the remaining features are tracked and built that way.

---

## Phase 0: Foundations and deployment ✅

**Goal:** an empty app, deployed privately, end to end.

- [x] Monorepo: Turborepo + Bun, shared lint and TypeScript configs
- [x] Design docs
- [x] `packages/db` (Drizzle schema + migrations), `packages/core`
- [x] `backend/api` (Hono) with health checks, `web/app` (Vite + TanStack Router + Query)
- [x] Auth: Better Auth (magic link, GitHub, Batele ID), organizations with owner actor, onboarding
- [x] Railway: api + Postgres 18 at `tracker-api.batele.plus`; no Railway public URL
- [x] Cloudflare Pages at `tracker.batele.plus`, DNS for both domains
- [x] Deploys: API from GitHub via Railway on push to `main` (`.railway/railway.ts`); web with `bun run deploy:web`

Cloudflare Access is deferred: it would get in the way of agent access (MCP, CLI). A sign-up allowlist (Phase 3) covers privacy instead.

---

## Phase 1: Core tracker basics ✅

**Goal:** projects and tasks usable in the browser.

- [x] Projects with keys and default statuses
- [x] Tasks (`SPI-123`): title, description, status, priority, assignees
- [x] Board (drag and drop) and list views; task page with inline editing
- [x] Activity log written for every change
- [x] Roles: guests read-only, owners/admins manage projects

---

## Phase 2: Agent access (next)

**Goal:** external agents work on tasks.

- [x] Agent actors (shown as members, owned by a person)
- [x] API keys (`spt_…`): Bearer auth on the same `/v1` routes the web app uses
- [x] Settings page to create agents and keys, and revoke keys
- [x] MCP server at `tracker-api.batele.plus/mcp` (agent API keys; comments come with the comments feature)
- [x] First version of the `spider` CLI: `whoami`, `projects`, `task list/view/create/update/start/done`, `--json` (`comment` comes with the comments feature)
- [x] Activity records `source` (ui / api / mcp / cli): API-key clients declare it with `X-Spider-Source`
- [x] OpenAPI spec (`/openapi.json`) and `packages/sdk`

**Done when:** Claude Code picks up a task over MCP, comments on progress and moves it to review, and this roadmap lives in Spider Tracker instead of this file.

---

## Phase 3: Tracker features

**Goal:** a complete task tracker, built with agents.

- Tags, sub-tasks, task relations (blocks / relates / duplicates)
- Comments and the activity feed on the task page
- Realtime: LISTEN/NOTIFY → SSE → TanStack Query
- Members, invitations, roles management
- Filters and saved views
- Keyboard shortcuts and command palette
- Sign-up allowlist and email delivery for magic links

---

## Phase 4: Git and GitHub

**Goal:** code and tasks stay in sync without manual updates.

- GitHub App, repository linking, repos attached to projects
- Automatic task ↔ branch / commit / pull request linking by task key
- Status automation from pull request events
- Pull request state, checks and reviews shown on the task
- CLI: `spider start` creates the branch, `spider pr` opens the pull request

**Done when:** opening and merging a pull request moves its task to review and then done, with no manual step.

---

## Phase 5: Hosted agents

**Goal:** agents run inside Spider Tracker, triggered by assignment.

- `backend/worker` with a Postgres job queue
- Agent runs via the Claude Agent SDK: triggers, run lifecycle, streamed events in the task
- Chat with a running agent; approval requests as buttons
- Guardrails: scoped permissions, budgets, approval gates, kill switch
- Sandbox for running code (provider to be decided)
- Agents opening pull requests

**Done when:** assigning a task to a hosted agent produces a reviewed pull request linked to the task.

---

## Phase 6: Documents, custom fields and apps

**Goal:** the flexible parts of the model.

- Markdown/HTML documents with version history; agents read and write them
- Custom field definitions (organization and project scope), used in views, filters and agent context
- File uploads to R2
- Apps linked to repos and projects

**Done when:** a project can define its own fields and a spec document that an agent uses while working.

---

## Phase 7: Polish and opening up

**Goal:** ready for people other than the owner.

- OAuth 2.1 / OIDC provider + device flow (CLI login, MCP clients without API keys, third-party apps)
- Cycles, milestones, timeline view
- Notifications, inbox, outbound webhooks
- Claude Code plugin (MCP + skill + channel)
- Optional GitHub Issues sync
