# Architecture

[← Project overview](./PROJECT.md) · Reasoning behind choices: [decisions.md](./decisions.md)

## Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript everywhere |
| Runtime & package manager | Bun |
| Monorepo | Turborepo + Bun workspaces |
| Frontend | Vite + React single-page app, TanStack Router, TanStack Query, Tailwind, shadcn/ui |
| API | Hono, with Zod schemas from `@repo/core` (validation and types; the OpenAPI spec is generated from them with `z.toJSONSchema`) |
| Database | Postgres on Railway, with row-level security per organization (driven by per-transaction settings, see [auth.md](./auth.md#database-access-rules)) |
| ORM / migrations | Drizzle |
| Job queue | pg-boss or Graphile Worker (Postgres-backed, no Redis) |
| Realtime | Postgres LISTEN/NOTIFY → `backend/api` → Server-Sent Events (SSE) to the browser |
| File storage | Cloudflare R2 (S3-compatible API), with presigned upload/download URLs |
| Auth | Better Auth inside `backend/api`; Spider Tracker is its own OAuth 2.1 / OIDC provider (see [auth.md](./auth.md)) |
| Agents | Claude Agent SDK for hosted agents; MCP for external ones |
| GitHub | GitHub App + Octokit |

## Monorepo layout

```
web/
  app/          Vite + React SPA (TanStack Router + Query); calls only the public API
backend/
  api/          Hono: REST API + MCP endpoint + GitHub webhooks + SSE stream
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
  Cloudflare Pages                 Railway
 ┌──────────────┐        ┌──────────────┐      ┌───────────────┐
 │   web/app    │──API──▶│              │─────▶│   Postgres    │
 │  (static)    │◀──SSE──│              │◀─────│ data · queue  │
 └──────────────┘        │ backend/api  │NOTIFY│ · notify      │
 CLI / SDK ─────────────▶│              │      └──────┬────────┘
 agents (MCP) ──────────▶│              │             │ jobs
 GitHub webhooks ───────▶│              │      ┌──────▼────────┐
                         └──────┬───────┘      │backend/worker │──▶ Claude API, GitHub
                                │ presigned    └──────┬────────┘
                                ▼ URLs                │
                         ┌──────────────┐             │
                         │ Cloudflare R2│◀────────────┘
                         └──────────────┘
```

- **API parity:** the web app uses the same public API as agents and the CLI.
- **Static frontend:** the SPA is built to static files and served from Cloudflare Pages. It has no server code; everything goes through `backend/api`.
- **Long-running work goes to the worker:** agent runs, webhook handling and notifications.
- **The API stays thin:** it validates, authorises, writes and enqueues. Domain rules live in `packages/core`.

## Realtime

1. Writes (API or worker) call `pg_notify('org_<id>', <event>)` inside the same transaction, so notifications go out only if the write commits.
2. Each `backend/api` instance keeps one dedicated `LISTEN` connection and passes events to its connected clients.
3. The browser opens one SSE stream (`GET /v1/stream`) per organization. TanStack Query updates or refetches the affected queries when events arrive.
4. Browser-to-server actions stay plain REST calls. WebSocket is added only if two-way low-latency traffic becomes necessary.

Notification payloads are kept small (entity type, ID, version) because of the ~8KB limit; clients fetch the full data. Agent token streams can use the same path; if volume grows, see [decisions.md](./decisions.md#5-no-message-broker-yet).

## File storage

- Attachments, avatars, document images and large agent artifacts live in R2.
- The API issues **presigned URLs**: the browser uploads and downloads directly to and from R2, never through the API.
- Object keys are prefixed by organization (`org/<org_id>/…`), and the API checks access before signing.
- Postgres stores only metadata (key, size, content type, owner).

## Domains and cookies

| Host | Serves |
|---|---|
| `tracker.batele.plus` | SPA (Cloudflare Pages) |
| `tracker-api.batele.plus` | `backend/api` (Railway) |

Both hosts belong to the same site (`batele.plus`), so the browser treats Better Auth's cookies as first-party.

- Cookies are **host-only** on `tracker-api.batele.plus` (`Secure`, `HttpOnly`, `SameSite=Lax`; Better Auth adds the `__Secure-` prefix over HTTPS). They are never set on `.batele.plus`, so other batele subdomains can't read them.
- The SPA calls the API with `credentials: "include"`. CORS allows only `https://tracker.batele.plus`, with credentials.

## Private access (for now)

While the project is private, both hosts sit behind **Cloudflare Access** (Zero Trust). Nothing is reachable without passing an access check first. Details: [decisions.md](./decisions.md#10-private-access-through-cloudflare-access).

| Caller | How it gets through |
|---|---|
| People (browser) | Access login (allowed emails or GitHub), then Better Auth as usual |
| CLI, external agents, CI | Access **service token** sent as headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) alongside the API key or OAuth token |
| MCP clients | Same service-token headers (e.g. `claude mcp add --transport http … --header …`). Clients that can't send custom headers (e.g. Claude.ai connectors) can't connect while private. |
| GitHub webhooks | **Bypass** rule for `/webhooks/github` only; requests are verified with the webhook signature |
| CORS preflight | Access setting "bypass OPTIONS requests to origin" turned on for `tracker-api` |

Railway's public URL for the API (`*.up.railway.app`) is disabled, so traffic can only arrive through Cloudflare. Postgres and the worker use Railway's private network only.

**Going public later:** remove the Access applications. Nothing else changes, since Better Auth already handles all real authentication.

## Hosting

| Part | Where |
|---|---|
| `web/app` | Cloudflare Pages |
| `backend/api`, `backend/worker` | Railway |
| Postgres 18 (needed for `uuidv7()`) | Railway |
| File storage | Cloudflare R2 |
| Agent code sandboxes | To be decided (Docker, E2B, Daytona…) |
