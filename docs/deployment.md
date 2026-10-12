# Deployment

[← Project overview](./PROJECT.md) · Hosting overview: [architecture.md](./architecture.md#hosting)

## Order

Deploy the **API first** and wait until Railway reports `SUCCESS` (`railway service status -s api`), then deploy the web app. A web build that expects new API fields can otherwise reach users before the API does.

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

### Agent invite pages (Pages Function)

`web/app/functions/agent-invite/[code].ts` is a Cloudflare Pages Function. `wrangler pages deploy` picks up the `functions/` directory of the directory it runs in, so `deploy:web` (which runs in `web/app`) bundles and uploads it with the static files; no extra step. It serves `/agent-invite/<CODE>` as server-rendered HTML (no JavaScript, so tools like Claude Code's WebFetch can read it) and as Markdown for `/agent-invite/<CODE>.md` or an `Accept` header preferring `text/markdown`/`text/plain`. It only checks the code's shape (bad shape → 404) and never calls the API, so opening a link never redeems or validates the code. The text comes from `web/app/src/lib/agent-invite-instructions.ts`, shared with the SPA route used under Vite in development. The function is type-checked with its own `web/app/functions/tsconfig.json` (`@cloudflare/workers-types`) as part of `check-types` and `build`.

Test it locally (Vite doesn't run Pages Functions):

```bash
bun run --cwd web/app preview:pages   # build, then bunx wrangler@4 pages dev dist --port 8788
curl -s localhost:8788/agent-invite/ABCD-EFGH.md
```

### CLI install script and releases

`web/app/public/install.sh` is served at `https://tracker.batele.plus/install.sh` (`public/_headers` gives it a `text/x-shellscript` content type). It downloads `spider-<darwin|linux>-<arm64|x64>` from the latest GitHub release of `pipisasa/spider-tracker` (or the tag in `SPIDER_VERSION`) into `${SPIDER_INSTALL_DIR:-$HOME/.local/bin}`.

Releases are **manual**. Bump `version` in `backend/cli/package.json`, then:

```bash
bun run release:cli --dry-run   # build the four binaries into dist/release only
bun run release:cli             # build, then gh release create cli-v<version> --latest
```

The release (binaries plus `SHA256SUMS`, which `install.sh` and `spider update` verify) is tagged at HEAD, so the script refuses a dirty working tree or a HEAD that is on no remote branch; `--dry-run` skips both checks.

**Release notes** live in [CHANGELOG.md](../CHANGELOG.md) (CLI, plugin, MCP server): add user-visible changes, especially breaking output changes, under **Unreleased**, and move them under the version when bumping it; paste the CLI's into the GitHub release.

`spider update` and the passive "new spider available" notice look for the release marked latest with a `cli-v*` tag, so keep CLI releases `--latest` (or the CLI falls back to the newest `cli-v*` release in the list).

**Minimum CLI version.** The API sends `X-Spider-Min-Cli` (`MIN_CLI_VERSION` in `packages/core/src/version.ts`). When an API change drops support for older CLIs, first release a CLI that works with it, then raise `MIN_CLI_VERSION` to that version and deploy the API; older CLIs then warn and suggest `spider update`. Bump the shared plugin's `version` (`plugins/spider-tracker/.claude-plugin/plugin.json`) whenever it changes so `claude plugin update` and the update check see it.

It needs `gh auth login` and a **public** repository (the install script downloads without credentials), and it refuses to run if the `cli-v<version>` tag already exists. Releasing the CLI is independent of the deploy order below; deploy the API and web app first if the new CLI relies on new endpoints.

### Custom domain

Both halves are needed:

1. Add `tracker.batele.plus` to the Pages project (Custom domains), so Pages accepts the host.
2. A proxied CNAME in the `batele.plus` zone: `tracker` → `spider-tracker.pages.dev`.

For a preview domain, add `tracker-dev.batele.plus` to the project and point its CNAME at `dev.spider-tracker.pages.dev`.

### Gotchas

- For a few minutes after a project is created, `*.pages.dev` can fail the TLS handshake and the custom domain can return `522`. Wait it out.
- Check the bundle that's actually served, not the config: `curl -s https://tracker.batele.plus | grep -o '/assets/index-[^"]*\.js'`, then search that asset for the API host.

## API and database: Railway

The API **deploys automatically from GitHub**: Railway builds `main` on every push that touches the API's paths. Service settings live in **`.railway/railway.ts`** (Railway infrastructure as code); change them there and run `railway config plan`, then `railway config apply --yes`.

| Thing | Value |
|---|---|
| Workspace / project | Batele / `spider-tracker` (environment `production`) |
| Services | `api`, `Postgres` |
| Postgres | Railway Postgres template (`postgres-ssl:18`), private network only (no public TCP proxy) |
| API source | GitHub `pipisasa/spider-tracker`, branch `main`; rebuilds only for `backend/api/**`, `packages/**`, `package.json`, `bun.lock`, `.railway/**` |
| API build | Railway's default builder (Railpack): `bun install` at the repo root; no Dockerfile |
| API deploy | pre-deploy `bun packages/db/src/migrate.ts` (migrations), start `bun backend/api/src/index.ts`, health check `/health/ready` |
| API domain | `tracker-api.batele.plus`; no `*.up.railway.app` domain is generated |

**API variables:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private `postgres.railway.internal`) |
| `API_ORIGIN` | `https://tracker-api.batele.plus` |
| `WEB_ORIGIN` | `https://tracker.batele.plus` |
| `BETTER_AUTH_SECRET` | random, set with `--stdin` so it never appears in output |
| `NODE_ENV` | `production` |
| `TRUSTED_PROXY` | `railway` (see below) |

**Client IP for rate limits (`TRUSTED_PROXY`).** The API's own rate limits (device codes, agent invite accepts, invitation codes) and Better Auth's (sign-in, magic links, …) key on the client IP, taken only from the proxy named in `TRUSTED_PROXY`; every other client-supplied header is ignored so a client can't get a fresh bucket per request:

| Value | Client IP | Use when |
|---|---|---|
| `none` (default) | The TCP peer address from Bun; one shared `unknown` bucket if there is none (e.g. `app.request` in tests) | Local development, no proxy |
| `railway` | The **right-most** `X-Forwarded-For` entry | Production: Railway's edge proxy in front of the API |
| `cloudflare` | `CF-Connecting-IP` | Only if the API hostname is proxied by Cloudflare (orange cloud) **and** unreachable any other way |

Production uses `railway` because `tracker-api` is a DNS-only (grey cloud) record: requests reach Railway's edge directly, so `CF-Connecting-IP` is whatever the client sent, and Bun's socket address is Railway's proxy (the same for everyone). Assumption: Railway's edge appends the address that connected to it to `X-Forwarded-For` (it also sets `X-Real-IP`). The right-most entry is used rather than `X-Real-IP` because an appended entry is correct whether or not the edge drops a client-sent header, while Railway doesn't document whether it overwrites a client-sent `X-Real-IP`. Anything to the left of that entry is client-controlled and ignored. If the hostname is ever switched to a proxied (orange cloud) record, the right-most entry becomes a Cloudflare edge address: switch to `cloudflare` at the same time. Better Auth gets the same IP: `app.ts` sets a private `X-Spider-Client-IP` header to it (dropping any client-sent copy) before handing `/api/auth/*` requests to Better Auth, which reads only that header (`backend/api/src/auth.ts`). Better Auth's rate limits are on when `NODE_ENV=production`.

**Deploy:** push to `main` (`git push`). Follow it with `railway service status -s api` and `railway logs -s api`. `bun run deploy:api` (`railway up`) still uploads the working tree directly, for emergencies.

**Custom domain DNS** (in the `batele.plus` zone):

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `tracker-api` | `kbfxs9zg.up.railway.app` | DNS only (grey cloud) until the certificate is issued |
| TXT | `_railway-verify.tracker-api` | `railway-verify=591212fea1d43b8a127e9cfa3e14bf312d375d29ba3114fdeaec3e3f2effcfb1` | — |

Check progress with `railway domain status 85cd76b1-5729-478c-9941-b52346e5840e`.

**GitHub App:** the six `GITHUB_APP_*` variables (all or none) turn on Settings → GitHub; how to create the App and set them is in [git-integration.md](./git-integration.md#manual-checklist-a-person).

**Email:** magic links are sent with [Resend](https://resend.com) when `RESEND_API_KEY` is set (`railway variable set RESEND_API_KEY --stdin -s api`), from `MAIL_FROM` (default `Spider Tracker <noreply@batele.plus>`; the `batele.plus` domain must be verified in Resend). Without the key the API logs a warning at startup and magic links only appear in `railway logs -s api`.

## Private access: Cloudflare Access

Not set up yet; see [architecture.md](./architecture.md#private-access-for-now).
