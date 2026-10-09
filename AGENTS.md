# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

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

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
