# Decisions

[← Project overview](./PROJECT.md)

Short records of technology choices. Add new ones at the bottom.

---

## 1. SQL over NoSQL

**Decision:** use a relational database.

**Why:**
- The data is deeply relational: organizations → projects → tasks → assignees, tags, relations, repos, pull requests and runs.
- Saved views are ad-hoc filters across many fields, which SQL handles naturally. A document store would need every access pattern planned in advance, plus duplicated data.
- Status changes, activity entries and run updates must commit together, which needs transactions.
- Reporting (cycle stats, agent cost, throughput) is plain SQL.

**Flexible data** (custom fields, run traces) goes into Postgres `JSONB` columns, so NoSQL brings no extra benefit.

---

## 2. Postgres over SQLite

**Decision:** Postgres on the server. SQLite only on clients, later.

**Why:**
- Agents, webhooks, workers and people all write at the same time. Postgres handles that well; SQLite allows only one writer at a time.
- The API and the worker run on different machines and need one shared database over the network.
- Row-level security gives organization isolation inside the database.
- Built-in change notifications (LISTEN/NOTIFY) power live updates.
- `JSONB` + GIN indexes, full-text search, pgvector and pg_cron.

**SQLite fits:** a local cache in the CLI or a desktop app, a single-user self-hosted mode, and scratch state during an agent run.

**Tests** run against real Postgres, not SQLite.

---

## 3. TypeScript (Node/Bun) over Elixir

**Decision:** a TypeScript backend.

**Why:**
- Agent tooling is strongest in TypeScript. The Claude Agent SDK, the MCP SDK and Octokit are all official and complete there. Elixir has only community libraries for these.
- One language across web, API, SDK and CLI, with shared types and Zod schemas.
- The workload waits on the database, GitHub and LLM calls, not CPU, so Node-style async handles it fine.

**Elixir's strengths** (supervised processes, Phoenix realtime, Oban) are real but don't outweigh the ecosystem gap for an agent-first product. A mixed Elixir + Node setup was rejected as too much overhead.

---

## 4. Separate API and worker, not framework API routes

**Decision:** `backend/api` (Hono) and `backend/worker` run as their own services.

**Why:** agent runs take minutes (beyond serverless time limits), webhooks need retries, and the public API is a first-class product rather than a frontend detail.

---

## 5. No message broker yet

**Decision:** Postgres provides the job queue (pg-boss or Graphile Worker) and live updates (LISTEN/NOTIFY, streamed to browsers over SSE).

**Revisit when:**
- many workers need to fan out high-frequency token streams,
- Postgres notifications become a bottleneck (they're capped at about 8KB per message), or
- the system grows into many separate services.

Then consider NATS or Redis Streams. External agents never connect to the broker directly; they always go through the API (MCP, WebSocket or SSE).

---

## 6. Bun as runtime and package manager

**Decision:** Bun for installs, scripts and backend runtime, inside a Turborepo monorepo.

**Why:** fast installs and startup, native TypeScript, and the same setup as other personal projects. Backend apps extend `@repo/typescript-config/bun.json`.

---

## 7. Better Auth for authentication

**Decision:** Better Auth, running inside `backend/api`, instead of Supabase Auth. Spider Tracker acts as its own OAuth 2.1 / OIDC provider. Details: [auth.md](./auth.md).

**Why:**
- MCP clients and the CLI must sign in to *us*, so we need an OAuth server, a device flow and API keys. Better Auth has plugins for all of them.
- It's TypeScript, runs in Hono on Bun, and stores its tables in our Postgres through Drizzle.
- Identity stays in our own database, with no separate auth schema.

**Trade-off:** no Supabase `auth.uid()` in database access rules. The API sets `app.org_id` and `app.actor_id` for each transaction, and the access rules read those instead.

**Batele ID:** added as an extra sign-in provider (generic OAuth, `batele-id`), without replacing our own provider. See [auth.md](./auth.md#batele-id-connected).

---

## 8. Vite SPA with TanStack Router and Query, not Next.js

**Decision:** `web/app` is a Vite + React single-page app using TanStack Router (type-safe routing) and TanStack Query (server state and caching), served as static files.

**Why:**
- The app sits behind login, so server rendering and SEO bring nothing. A marketing site can be separate later.
- All data comes from our public API (API parity); the frontend needs no server code of its own.
- Static files host cheaply anywhere (Cloudflare Pages) with no server runtime.
- TanStack Query's cache fits optimistic updates and applying realtime events.
- Fast Vite dev server and builds; no framework lock-in.

**Trade-off:** no server rendering; the first load shows a loading shell. That's acceptable for a logged-in tool.

---

## 9. No Supabase: Railway Postgres, Cloudflare Pages and R2

**Decision:** Postgres and the backend run on Railway; the frontend on Cloudflare Pages; file storage on Cloudflare R2.

**Why:**
- After choosing Better Auth, Supabase would only provide Postgres, Realtime and storage. Each has a simple replacement, and fewer vendors means less to manage.
- Postgres sits next to the API and worker on Railway's private network: low latency, no public database endpoint.
- R2 is S3-compatible with no download (egress) fees, and is already used for `cdn.batele.plus`.
- Cloudflare Pages serves the static SPA from the edge.

**Replacements:**
- Realtime → LISTEN/NOTIFY + SSE from `backend/api` (see [architecture.md](./architecture.md#realtime)).
- Storage → R2 with presigned URLs.
- Database backups → Railway backups, plus scheduled `pg_dump` to R2.

**Trade-off:** we build and run the realtime layer ourselves.

---

## 10. Private access through Cloudflare Access

**Decision:** while the project is private, `tracker.batele.plus` and `tracker-api.batele.plus` sit behind Cloudflare Access. Setup: [architecture.md](./architecture.md#private-access-for-now).

**Why:**
- The domain and frontend are already on Cloudflare, so there's nothing extra to run.
- It works the same for browsers, the CLI and agents (service tokens), and allows path exceptions for GitHub webhooks.
- It's a gate in front of the app, independent of Better Auth, and can be removed when the project goes public.

**Alternative considered: Tailscale.** Gives no public surface at all, but:
- Railway containers would need `tailscaled` running inside them (userspace mode), plus TLS certificates via DNS challenge.
- GitHub webhooks couldn't reach a tailnet-only API without Tailscale Funnel or a separate public receiver.
- Every agent and CI machine would have to join the tailnet.

Revisit Tailscale if the API must have no public endpoint at all.

---

## 11. HTML documents render in a fully sandboxed iframe

**Decision:** HTML documents are shown in `<iframe sandbox="" srcdoc=…>`: no `allow-scripts`, no `allow-same-origin`, no forms or popups. Markdown documents are rendered with react-markdown and raw HTML inside Markdown is skipped.

**Why:**
- Documents are written by people and agents alike; an agent could be prompt-injected into writing hostile HTML. With an empty `sandbox`, the frame gets a unique opaque origin, can't run scripts and can't reach the app, its cookies or the API.
- No HTML sanitizer to keep up to date, and documents still render exactly as written (styles, tables, layout).

**Trade-off:** no interactive HTML (scripts, forms), and the frame can't size itself to its content, so it gets a fixed, resizable height. Revisit with a separate sandbox origin if interactive reports are ever needed.

**Avatar credits:** generated avatars use the DiceBear styles Notionists (CC0) and Bottts (by Pablo Stanley, free for personal and commercial use), rendered locally with @dicebear 9.4.3.

---

## 12. Project rules are a pointer to a project document

**Decision:** a project's rules for agents (ST-111) are a nullable `projects.rules_document_id` pointing at one of the project's own project-level documents, not a flag on documents or a separate text field.

**Why:**
- "At most one per project" is the column itself; no partial unique index, and replacing the rules is one update.
- The rules stay a normal document: versions, links, the editor and the API all work unchanged.
- Agents get them through the MCP server's instructions on `initialize`, which every MCP session (plugin or `spider claude`) reads first, so neither the generated agent file nor the channel has to be regenerated when they change.
- Changes are inbox items of a new kind `rules` about a document (`inbox_items.task_id` became nullable, with a `document_id`). Clients from before it expect a task on every item, so the API returns `rules` items only when `kinds` asks for them.

**Trade-off:** rules belong to one project; organization-wide rules shared by several projects would need a different shape.
