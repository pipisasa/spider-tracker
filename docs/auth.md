# Authentication

[← Project overview](./PROJECT.md) · Decision: [decisions.md](./decisions.md#7-better-auth-for-authentication)

## Approach

Authentication uses **Better Auth**, running inside `backend/api` (Hono on Bun) and storing its tables in our Postgres through Drizzle.

Spider Tracker is its own **OAuth 2.1 / OpenID Connect (OIDC) provider**: MCP clients, the CLI and, later, third-party apps sign in to us. Signing in through `id.batele.plus` will be added later as an extra login option (see [below](#later-idbateleplus)).

## Flows

| Who | Flow | Result |
|---|---|---|
| **People in the web app** | GitHub / Google sign-in (authorization code + PKCE), plus email magic link | Secure session cookie |
| **CLI** (`spider login`) | Device flow: the CLI shows a code, the user approves it in the browser | Access + refresh token, kept in the OS keychain |
| **MCP clients** (Claude Code, Claude.ai, Cursor…) | OAuth 2.1 + PKCE with automatic client registration, as the MCP spec requires | Token limited to the MCP endpoint |
| **Hosted agents** (our worker) | No OAuth: the worker issues a short-lived token per run, scoped to the run's task and permissions | Token that expires when the run ends |
| **External agents, CI** | API keys | Long-lived, revocable key |
| **Third-party apps** (later) | Authorization code + PKCE with a consent screen ("Sign in with Spider Tracker") | Scoped tokens + ID token |
| **GitHub** | Separate from login: the GitHub App installation, plus each user linking their GitHub account | Commits and pull requests attributed to the right person |

## Better Auth plugins

| Need | Plugin |
|---|---|
| GitHub / Google sign-in | Built-in social providers |
| Email login | Magic link |
| OAuth / OIDC provider (MCP clients, third-party apps) | OAuth/OIDC provider plugin + JWT plugin (signing keys at `/jwks`) |
| CLI login | Device authorization plugin |
| `id.batele.plus` login (later) | Generic OAuth plugin, pointed at its discovery URL |

Plugin names have changed between Better Auth versions; check current docs when implementing.

## What owns what

- **Better Auth owns identity:** users, sessions, linked accounts, verification codes, OAuth clients, consents and tokens, device codes, signing keys.
- **We own tenancy and actors:** `organizations`, `actors`, `agents`, `api_tokens` (see [data-model.md](./data-model.md)). Better Auth's organization plugin isn't used, because organizations and members are modelled as actors.
- A human actor links to a Better Auth user through `actors.user_id`.

## Agent-first rule: who is acting

When a person connects an MCP client through OAuth, the client does **not** act as that person. On the consent screen we create (or reuse) an **agent actor** owned by them, for example "Pipi's Claude Code":

- It shows up as an agent in assignments and the activity log, with its owner recorded.
- Its permissions are at most the owner's, narrowed by the approved scopes.
- It can be revoked on its own, without logging the person out.

The agent stores the OAuth client it belongs to (`agents.oauth_client_id`), so each incoming token resolves to the token's user + client → that agent actor.

## Scopes

`openid` `profile` `email` `offline_access` (OIDC standard), plus:

`tasks:read` `tasks:write` `comments:write` `docs:read` `docs:write` `agents:run` `projects:admin` `org:admin`

Every token is tied to one actor and one organization.

## Tokens

- **Access tokens:** short-lived, about 15 minutes.
- **Refresh tokens:** replaced every time they're used; reusing an old one revokes the whole set.
- **API keys:** stored as hashes, shown only once, prefixed `spt_` so leaks are easy to spot.
- **Revocation:** everything can be revoked under Settings → Connected apps & agents.

## Database access rules

Row-level security can't rely on a built-in auth user ID, so the API opens each request's transaction with:

```sql
select set_config('app.org_id', '<org>', true), set_config('app.actor_id', '<actor>', true);
```

and the row-level security policies compare `org_id` to `current_setting('app.org_id')`.

## Later: id.batele.plus

`id.batele.plus` is added as an extra sign-in provider through Better Auth's generic OAuth plugin, using its OIDC discovery URL. A batele identity links to the same Better Auth user (account linking by verified email), so existing actors are unaffected. Spider Tracker stays its own OAuth/OIDC provider for MCP, the CLI and third-party apps.
