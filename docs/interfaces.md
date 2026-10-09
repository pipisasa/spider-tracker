# Interfaces

[← Project overview](./PROJECT.md)

Anything possible in the UI is also possible through these interfaces. The web app uses the same public API.

| Interface | Purpose |
|---|---|
| **Web app** | Main UI |
| **Public API** | REST with an OpenAPI spec, generated from Zod schemas |
| **MCP server** | Native tool access for agents, served over HTTP from `backend/api` |
| **CLI** | `spider`, for people, scripts and agents |
| **Webhooks** | Outbound events: tasks, comments, runs, git links |
| **GitHub App** | Inbound repository events; outbound branch and pull request actions |

## Authentication

See [auth.md](./auth.md) for all flows.

- **People:** session cookie in the browser; OAuth device flow for the CLI.
- **MCP clients:** OAuth 2.1, each connected client becoming its own agent actor.
- **Agents, CI and integrations:** API keys, stored only as hashes, scoped and revocable.

## MCP server

Tools: list and search tasks, get a task, create and update tasks, comment, change status, assign, read and write documents, list projects and fields. Every action records `source = mcp`.

## CLI

### Stack
- TypeScript, built on `packages/sdk` and `packages/core`
- Commander (or oclif if a plugin system is needed); @clack/prompts for interactive prompts
- Distributed through npm and as standalone binaries (`bun build --compile`) for Homebrew and curl installs
- Tokens kept in the OS keychain, with a config-file fallback

### Authentication
- `spider login`: OAuth device flow in the browser
- `SPIDER_TOKEN` environment variable for agents and CI
- `spider org switch <org>`, plus per-repo defaults in `.spider.json`

### Commands
```bash
spider task list --mine --status in_progress
spider task view SPI-123
spider task create "Fix login redirect" --project SPI --tag bug --assign @claude-agent
spider task update SPI-123 --status review --field severity=high
spider comment SPI-123 "Root cause is the cookie domain"

spider start SPI-123      # assign to me, set In Progress, create + check out branch
spider pr                 # open a pull request linked to the current branch's task
spider done               # mark the current branch's task done

spider agent list
spider agent run @reviewer SPI-123
spider agent logs <run-id> --follow

spider doc pull SPEC-12 > spec.md
spider doc push SPEC-12 spec.md
```

### Rules that make it work for agents
1. `--json` on every command, with stable output shapes.
2. Never requires interaction: every prompt has a flag. When not attached to a terminal, it fails with a clear error instead of waiting.
3. Meaningful exit codes: `0` success, `2` validation, `3` not found, `4` permission.
4. Git awareness: it finds the task from the current branch name.
5. Compact default output, so it uses little of an agent's context window.

### Later
- Local SQLite cache for instant reads and offline use
- `spider tui`: a full-screen terminal UI (Ink)

## Webhooks

Outbound, signed, retried through the job queue. Events: `task.*`, `comment.*`, `agent_run.*`, `git_link.*`.
