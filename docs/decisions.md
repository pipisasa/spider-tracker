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
- Built-in change notifications (LISTEN/NOTIFY) and Supabase Realtime power live updates.
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

## 4. Separate API and worker, not Next.js API routes alone

**Decision:** `backend/api` (Hono) and `backend/worker` run as their own services.

**Why:** agent runs take minutes (beyond serverless time limits), webhooks need retries, and the public API is a first-class product rather than a frontend detail.

---

## 5. No message broker yet

**Decision:** Postgres provides the job queue (pg-boss or Graphile Worker) and live updates (LISTEN/NOTIFY or Supabase Realtime).

**Revisit when:**
- many workers need to fan out high-frequency token streams,
- Postgres notifications become a bottleneck (they're capped at about 8KB per message), or
- the system grows into many separate services.

Then consider NATS or Redis Streams. External agents never connect to the broker directly; they always go through the API (MCP, WebSocket or SSE).

---

## 6. Bun as runtime and package manager

**Decision:** Bun for installs, scripts and backend runtime, inside a Turborepo monorepo.

**Why:** fast installs and startup, native TypeScript, and the same setup as other personal projects. Backend apps extend `@repo/typescript-config/bun.json`.
