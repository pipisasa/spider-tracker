# Deployment

[← Project overview](./PROJECT.md) · Hosting overview: [architecture.md](./architecture.md#hosting)

## Web app: Cloudflare Pages

Deploys are **manual** (no CI/CD): build locally, upload with `wrangler pages deploy`.

| Thing | Value |
|---|---|
| Pages project | `spider-tracker` (direct upload) |
| Production | `--branch main` → `tracker.batele.plus` |
| Build-time config | `web/app/.env.production` (committed; public values only) |
| SPA fallback | Automatic on Pages; no `_redirects` or `404.html` needed |
| Account ID | `237695007150b566811a4822a8c0095e` |
| Zone | `batele.plus` |

**Deploy:**

```bash
bunx wrangler login     # once; interactive
bun run deploy:web      # build with .env.production, then upload to the spider-tracker project
```

`VITE_API_URL` is baked into the bundle at build time: `https://tracker-api.batele.plus`. Vite's production mode reads `web/app/.env.production`, which overrides the local `.env`.

### Custom domain

Both halves are needed:

1. Add `tracker.batele.plus` to the Pages project (Custom domains), so Pages accepts the host.
2. A proxied CNAME in the `batele.plus` zone: `tracker` → `spider-tracker.pages.dev`.

For a preview domain, add `tracker-dev.batele.plus` to the project and point its CNAME at `dev.spider-tracker.pages.dev`.

### Gotchas

- For a few minutes after a project is created, `*.pages.dev` can fail the TLS handshake and the custom domain can return `522`. Wait it out.
- Check the bundle that's actually served, not the config: `curl -s https://tracker.batele.plus | grep -o '/assets/index-[^"]*\.js'`, then search that asset for the API host.

## API and database: Railway

Deploys are **manual**: `railway up` uploads the local working tree and builds it on Railway.

| Thing | Value |
|---|---|
| Workspace / project | Pipisasa's Projects / `spider-tracker` (environment `production`) |
| Services | `api`, `Postgres` |
| Postgres | Railway Postgres template (`postgres-ssl:18`), private network only (no public TCP proxy) |
| API build | `backend/api/Dockerfile`, selected by the `RAILWAY_DOCKERFILE_PATH` variable; build context is the repo root |
| API start | Applies migrations (`packages/db/src/migrate.ts`), then starts the server on Railway's `PORT` (8080) |
| API domain | `tracker-api.batele.plus` → port 8080; no `*.up.railway.app` domain is generated |

**API variables:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private `postgres.railway.internal`) |
| `API_ORIGIN` | `https://tracker-api.batele.plus` |
| `WEB_ORIGIN` | `https://tracker.batele.plus` |
| `BETTER_AUTH_SECRET` | random, set with `--stdin` so it never appears in output |
| `NODE_ENV` | `production` |
| `RAILWAY_DOCKERFILE_PATH` | `backend/api/Dockerfile` |

**Deploy:**

```bash
railway login            # once; interactive
railway link             # once per checkout: project spider-tracker, environment production
bun run deploy:api       # railway up --service api
railway logs -s api      # follow logs
```

Migrations run on every start. That's fine while the API runs as a single instance; move them to a separate release step before scaling out.

**Custom domain DNS** (in the `batele.plus` zone):

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `tracker-api` | `kbfxs9zg.up.railway.app` | DNS only (grey cloud) until the certificate is issued |
| TXT | `_railway-verify.tracker-api` | `railway-verify=591212fea1d43b8a127e9cfa3e14bf312d375d29ba3114fdeaec3e3f2effcfb1` | — |

Check progress with `railway domain status 85cd76b1-5729-478c-9941-b52346e5840e`.

**Email:** the API still uses the console mailer, so magic links appear in `railway logs -s api`, not in an inbox.

## Private access: Cloudflare Access

Not set up yet; see [architecture.md](./architecture.md#private-access-for-now).
