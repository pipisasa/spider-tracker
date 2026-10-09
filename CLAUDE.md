# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `docs/PROJECT.md` for the core idea; detailed docs (features, data model, architecture, decisions, agents, roadmap) live alongside it in `docs/`.

## Package Manager

Use **bun** exclusively. Do not use npm, yarn, or pnpm.

## Common Commands

```bash
bun run build          # Build all apps and packages
bun run dev            # Dev servers for all apps (TUI mode)
bun run lint           # Lint all apps and packages
bun run check-types    # Type-check all apps and packages
bun run test           # Run tests
bun run format         # Format with Prettier (ts, tsx, md)

bun run db:generate    # Generate a migration from schema changes (packages/db)
bun run db:migrate     # Apply migrations to DATABASE_URL

# Filter to a specific app/package
bunx turbo run dev --filter=@repo/<name>
```

## Architecture

Turborepo monorepo with bun workspaces.

| Folder | Contents |
|---|---|
| `web/*` | Web apps (frontends) |
| `backend/*` | Backend apps (APIs, workers, CLI, services) |
| `packages/*` | Shared packages |

### Apps

- **`@repo/api`** (`backend/api`) — Hono on Bun, port 4000. Better Auth mounted at `/api/auth/*`; signed-in routes under `/v1/*`; `/health` and `/health/ready`. `/mcp` is a stateless Streamable HTTP MCP server (`src/mcp.ts`, `@modelcontextprotocol/sdk`) for agent API keys only; its tools call core with `source = "mcp"`.
- **`@repo/cli`** (`backend/cli`) — the `spider` CLI on `@repo/sdk` + Commander, recording `source = cli`. `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd? })` (testable, never prompts; exit codes 0/1/2/3/4); `src/index.ts` is the bin. Auth via `SPIDER_TOKEN`, optional `SPIDER_API_URL`. Run with `bun run spider …`; `build` compiles `dist/spider`. Its integration test drives the API app (`@repo/api` is a dev dependency).
- **`@repo/web`** (`web/app`) — Vite + React SPA, port 5173. TanStack Router (file-based routes in `src/routes`, `_authed` layout guards signed-in pages) + TanStack Query. shadcn/ui (radix-nova) components in `src/components/ui` (generated; don't lint or hand-edit).

### Packages

- **`@repo/db`** — Drizzle schema (`src/schema`), `createDb()`, migrations in `migrations/`. Better Auth tables live in `schema/auth.ts`; their property names must match Better Auth's field names. IDs default to Postgres 18 `uuidv7()`.
- **`@repo/core`** — Domain logic used by api/worker/cli (`createOrganization`, …), shared Zod schemas (`@repo/core/schemas`) and API response types (`@repo/core/contracts`). The web app imports only those subpaths, never the root (it pulls in the database).

- **`@repo/eslint-config`** — Shared ESLint flat configs. Exports `./base` (backend/libraries), `./next-js`, and `./react-internal`. Uses `eslint-plugin-only-warn`; apps run lint with `--max-warnings 0`.
- **`@repo/typescript-config`** — Shared tsconfig bases: `base.json`, `bun.json` (backend apps on Bun; add `@types/bun`), `nextjs.json`, `react-library.json`, `vite.json`.

### Local setup

Requires Postgres 18 (for `uuidv7()`). Copy `.env.example` to `.env` in `packages/db`, `backend/api` and `web/app`; set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`). Magic links are printed to the API console in development.

Tests: `bun run test`. Database tests run only when `TEST_DATABASE_URL` points to a migrated database (e.g. `postgres://localhost:5432/spider_tracker_test`).

### Working with the tracker

The roadmap lives in Spider Tracker itself (project `ST`). The `spider-tracker` skill (`.claude/skills/spider-tracker/SKILL.md`) describes how to pick up, start and hand off tasks. `.mcp.json` registers the `spider` MCP server with `Authorization: Bearer ${SPIDER_TOKEN}`; export `SPIDER_TOKEN` (an agent API key) before starting Claude Code, otherwise use `bun run spider … --json`.

## Conventions

- All packages are named `@repo/<name>` and depend on internal packages with `"*"`.
- ESM throughout (`"type": "module"`).
- TypeScript 5.9, ESLint 9 flat config.
- **No `any`**: use `unknown` + narrowing, generics, or precise types.
- Every app/package exposes `lint` and `check-types` scripts; long-running apps expose `dev`.
- Business rules go in `@repo/core`, not in route handlers; handlers validate, call core, and map `DomainError` codes to HTTP statuses.
- Read environment variables only through `backend/api/src/env.ts` (Zod-validated). New env vars must be added to `globalEnv` in `turbo.json`.
