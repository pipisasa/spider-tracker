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

No apps exist yet.

### Packages

- **`@repo/eslint-config`** — Shared ESLint flat configs. Exports `./base` (backend/libraries), `./next-js`, and `./react-internal`. Uses `eslint-plugin-only-warn`; apps run lint with `--max-warnings 0`.
- **`@repo/typescript-config`** — Shared tsconfig bases: `base.json`, `bun.json` (backend apps on Bun; add `@types/bun`), `nextjs.json`, `react-library.json`, `vite.json`.

## Conventions

- All packages are named `@repo/<name>` and depend on internal packages with `"*"`.
- ESM throughout (`"type": "module"`).
- TypeScript 5.9, ESLint 9 flat config.
- **No `any`**: use `unknown` + narrowing, generics, or precise types.
- Every app/package exposes `lint` and `check-types` scripts; long-running apps expose `dev`.
