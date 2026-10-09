# Architecture

[← Project overview](./PROJECT.md) · Reasoning behind choices: [decisions.md](./decisions.md)

## Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript everywhere |
| Runtime & package manager | Bun |
| Monorepo | Turborepo + Bun workspaces |
| Frontend | Next.js (App Router), React, Tailwind, shadcn/ui |
| API | Hono, with Zod + `@hono/zod-openapi` (one schema gives validation, types and OpenAPI docs) |
| Database | Postgres (Supabase), with row-level security per organization |
| ORM / migrations | Drizzle |
| Job queue | pg-boss or Graphile Worker (Postgres-backed, no Redis) |
| Realtime | Supabase Realtime at first; a custom sync engine possibly later |
| Auth | Supabase Auth for people (GitHub OAuth + email); hashed API tokens for agents |
| Agents | Claude Agent SDK for hosted agents; MCP for external ones |
| GitHub | GitHub App + Octokit |

## Monorepo layout

```
web/
  app/          Next.js UI; calls only the public API
backend/
  api/          Hono: REST API + MCP endpoint + GitHub webhooks
  worker/       Agent runs, webhook processing, GitHub sync, notifications
  cli/          `spider` CLI
packages/
  core/         Domain logic (tasks, permissions, workflows), used by api, worker and cli
  db/           Drizzle schema + migrations
  sdk/          Typed API client (web, cli, external agents)
  eslint-config/
  typescript-config/
```

## Services

```
            ┌──────────┐      ┌──────────┐
 browser ──▶│ web/app  │─────▶│          │
            └──────────┘      │          │      ┌───────────────┐
 CLI / SDK ──────────────────▶│ backend/ │─────▶│   Postgres    │
 external agents (MCP) ──────▶│   api    │      │ data · queue  │
 GitHub webhooks ────────────▶│          │      │ · realtime    │
                              └──────────┘      └──────┬────────┘
                                                       │ jobs
                                                ┌──────▼────────┐
                                                │backend/worker │──▶ Claude API, GitHub
                                                └───────────────┘
```

- **API parity:** the web app uses the same public API as agents and the CLI.
- **Long-running work goes to the worker:** agent runs, webhook handling and notifications all run there. Serverless time limits rule them out of the API.
- **The API stays thin:** it validates, authorises, writes and enqueues. Domain rules live in `packages/core`.

## Hosting

| Part | Where |
|---|---|
| `web/app` | Vercel |
| `backend/api`, `backend/worker` | Railway |
| Postgres, auth, storage | Supabase |
| Agent code sandboxes | To be decided (Docker, E2B, Daytona…) |
