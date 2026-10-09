# Spider Tracker

Agent-first task tracker and project management tool. See [docs/PROJECT.md](./docs/PROJECT.md).

## Getting started

Requires [Bun](https://bun.sh) and Postgres 18.

```bash
bun install
createdb spider_tracker_dev
for d in packages/db backend/api web/app; do cp $d/.env.example $d/.env; done
# set BETTER_AUTH_SECRET in backend/api/.env  (openssl rand -base64 32)
bun run db:migrate
bun run dev
```

Open http://localhost:5173 and sign in with a magic link; the link is printed in the API console.

## Layout

- `web/` — web apps
- `backend/` — backend apps
- `packages/` — shared config and libraries
- `docs/` — project documentation

Built with [Turborepo](https://turborepo.dev) and [Bun](https://bun.sh).
