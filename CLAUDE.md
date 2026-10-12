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

- **`@repo/api`** (`backend/api`) — Hono on Bun, port 4000. Better Auth mounted at `/api/auth/*`; signed-in routes under `/v1/*`; `/health`, `/health/ready` and a public OpenAPI 3.1 spec at `/openapi.json` (`src/openapi.ts`; request bodies generated from the core Zod schemas, so update it when routes change), rendered by Swagger UI at `/swagger` and Scalar at `/scalar` (`src/api-docs.ts`). `/mcp` is a stateless Streamable HTTP MCP server (`src/mcp.ts`, `@modelcontextprotocol/sdk`) for agent API keys only; its tools call core with `source = "mcp"`.
- **`@repo/cli`** (`backend/cli`) — the `spider` CLI on `@repo/sdk` + Commander, recording `source = cli`. `src/cli.ts` exports `run(argv, { env, fetch?, stdout, stderr, cwd?, openUrl?, sleep? })` (testable, never prompts; exit codes 0/1/2/3/4); `src/index.ts` is the bin. Auth: `--as <agent>` > `SPIDER_TOKEN` > `SPIDER_AGENT` > the default saved agent. `~/.config/spider-tracker/credentials.json` (`src/credentials.ts`) nests saved agents server → org → handle, added by `spider accept-invite` and `spider login` (device flow); optional `SPIDER_API_URL`. `spider claude [agent]` starts Claude Code as a saved agent (temp secret-free MCP config + channel, an explicit `--permission-mode`, warnings for broken settings hooks; the command line is built in `src/claude-launch.ts`; spawn and picker are injected into `run`). The Claude Code plugin `plugins/spider-tracker` (`/spider-tracker:create-agent`) is listed in `.claude-plugin/marketplace.json`. `spider update [--check] [--hook]` updates the binary, the shared plugin and generated agent files (`src/update*.ts`, `src/self-update.ts`); a daily cached check prints a notice at a terminal (off with `SPIDER_NO_UPDATE_CHECK` or `CI`). Run with `bun run spider …`; `build` compiles `dist/spider`. Its integration test drives the API app (`@repo/api` is a dev dependency). `spider setup claude` installs the `spider-tracker` plugin; `spider accept-invite` writes the agent's Claude Code agent into a private plugin (`<config dir>/claude-plugin`, `spider-agents@spider-local`, agents `spider-agents:<server>:<org>:<name>`). All `claude` calls go through the injected `runClaude`. `spider start [key]` (= `spider task start`) also switches to the task's branch (`branchNameFor`); git commands go through the injected `git` runner (`src/git.ts`), faked in tests. `spider claude <agent>… | --all [--project <key>] --tmux <session> [--dry-run]` opens a tmux window per agent (named by handle, existing ones skipped) running `spider claude <agent>`; tmux goes through the injected `tmux` runner (`src/tmux.ts`).
- **`@repo/web`** (`web/app`) — Vite + React SPA, port 5173. TanStack Router (file-based routes in `src/routes`, `_authed` layout guards signed-in pages) + TanStack Query. shadcn/ui (radix-nova) components in `src/components/ui` (generated; don't lint or hand-edit).

### Packages

- **`@repo/db`** — Drizzle schema (`src/schema`), `createDb()`, migrations in `migrations/`. Better Auth tables live in `schema/auth.ts`; their property names must match Better Auth's field names. IDs default to Postgres 18 `uuidv7()`.
- **`@repo/core`** — Domain logic used by api/worker/cli (`createOrganization`, …), shared Zod schemas (`@repo/core/schemas`), API response types (`@repo/core/contracts`) task keys in git (`@repo/core/git`: `taskKeyFromBranch`, `taskKeysIn`, `closingKeysIn`, `branchNameFor`), line diffs of document versions (`@repo/core/diff`) and the output shapes the CLI `--json` and MCP share (`@repo/core/views`: `taskView`, `commentView`, `documentVersionView`, `documentDiffView`, `projectRulesView`). The web app imports only db-free subpaths (`schemas`, `contracts`, `git`, `diff`, `views`, …), never the root (it pulls in the database).

- **`@repo/sdk`** — Typed API client: `createClient({ baseUrl, token?, source?, fetch? })` with `whoami`, `members`, `projects`, `tasks`; throws `SpiderApiError` on non-2xx. Imports only the `@repo/core/contracts` and `/schemas` subpaths, so it runs in browsers. API tests drive it against the app with `fetch: (input, init) => app.request(input, init)`.

- **`@repo/eslint-config`** — Shared ESLint flat configs. Exports `./base` (backend/libraries), `./next-js`, and `./react-internal`. Uses `eslint-plugin-only-warn`; apps run lint with `--max-warnings 0`.
- **`@repo/typescript-config`** — Shared tsconfig bases: `base.json`, `bun.json` (backend apps on Bun; add `@types/bun`), `nextjs.json`, `react-library.json`, `vite.json`.

### Local setup

Requires Postgres 18 (for `uuidv7()`). Copy `.env.example` to `.env` in `packages/db`, `backend/api` and `web/app`; set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`). Magic links are printed to the API console in development.

Tests: `bun run test`. Database tests run only when `TEST_DATABASE_URL` points to a migrated database (e.g. `postgres://localhost:5432/spider_tracker_test`).

### Working with the tracker

The roadmap lives in Spider Tracker itself (project `ST`, org `batele`). The Claude Code plugin `plugins/spider-tracker` (enabled for this repo in `.claude/settings.json`; `spider setup claude` installs it) provides the `tasks` skill (`skills/tasks/SKILL.md`: how to pick up, start and hand off tasks), the `spider` MCP server (its `headersHelper`, `spider mcp-headers`, supplies the key from `SPIDER_TOKEN` or a saved agent; needs the installed `spider` binary) and `/spider-tracker:create-agent`. `bun run claude:channel` starts a session with `spider channel`, which pushes the agent's tracker inbox (mentions, assignments, replies) into it (docs/agents.md). Without MCP, use `bun run spider … --json`.

## Conventions

- All packages are named `@repo/<name>` and depend on internal packages with `"*"`.
- ESM throughout (`"type": "module"`).
- TypeScript 5.9, ESLint 9 flat config.
- **No `any`**: use `unknown` + narrowing, generics, or precise types.
- Every app/package exposes `lint` and `check-types` scripts; long-running apps expose `dev`.
- Business rules go in `@repo/core`, not in route handlers; handlers validate, call core, and map `DomainError` codes to HTTP statuses.
- Read environment variables only through `backend/api/src/env.ts` (Zod-validated). New env vars must be added to `globalEnv` in `turbo.json`.
