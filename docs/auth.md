# Authentication

[← Project overview](./PROJECT.md) · Decision: [decisions.md](./decisions.md#7-better-auth-for-authentication)

## Approach

Authentication uses **Better Auth**, running inside `backend/api` (Hono on Bun) and storing its tables in our Postgres through Drizzle.

Spider Tracker is its own **OAuth 2.1 / OpenID Connect (OIDC) provider**: MCP clients, the CLI and, later, third-party apps sign in to us. Signing in through `id.batele.plus` will be added later as an extra login option (see [below](#later-idbateleplus)).

## Flows

| Who | Flow | Result |
|---|---|---|
| **People in the web app** | GitHub / Google sign-in (authorization code + PKCE), plus email magic link | Secure session cookie |
| **CLI** (`spider login`) | Device flow (RFC 8628): the CLI shows a code, the person approves it at `/device` | An API key for a per-device agent member owned by the person, in `~/.config/spider-tracker/credentials.json` (0600). Implemented in-house (`device_codes` table), see [interfaces.md](./interfaces.md#login-device-flow-rfc-8628) |
| **MCP clients** (Claude Code, Claude.ai, Cursor…) | OAuth 2.1 + PKCE with automatic client registration, as the MCP spec requires | Token limited to the MCP endpoint |
| **Hosted agents** (our worker) | No OAuth: the worker issues a short-lived token per run, scoped to the run's task and permissions | Token that expires when the run ends |
| **External agents, CI** | API keys | Long-lived, revocable key |
| **Third-party apps** (later) | Authorization code + PKCE with a consent screen ("Sign in with Spider Tracker") | Scoped tokens + ID token |
| **GitHub** | Separate from login: the GitHub App installation, plus each user linking their GitHub account | Commits and pull requests attributed to the right person |

## Who can sign up

`SIGNUP_ALLOWLIST` (API env) lists emails and `@domain` entries allowed to **create** an account; empty means anyone. Existing users always sign in.

- Better Auth's `user.validateUserInfo` hook rejects `create-user` for addresses outside the list, for every method (magic link, GitHub, Batele ID). Browser flows land on `/login?error=signup_not_allowed`.
- The address must also be verified by the sign-in method (`isSignupAllowed` in `@repo/core`): anyone can put a listed address on their provider profile. Magic links verify it by delivery; GitHub only when it reports the email as verified. Batele ID doesn't report verified emails, so while the list is set it can't sign up a listed real address: such users sign up by magic link, then link Batele ID from the home page.
- Magic links aren't sent to addresses that would be refused (and don't belong to an existing user); the response is the same either way, so the form doesn't reveal the list.
- Timing doesn't reveal it either (ST-56): every request does the same existing-user lookup (`mayReceiveMagicLink` in `@repo/core`), and the email is sent in the background after the response; send failures are only logged.
- Email is optional for Batele ID: users without one get `<sub>@users.batele-id.invalid` and may always sign up through Batele ID, list or not (the list only gates real addresses; `.invalid` never receives a magic link). Other methods can't use the placeholder domain to bypass the list.
- The login page shows the email magic-link form only when it is the only sign-in method.
- Production: set on Railway (`railway variable set SIGNUP_ALLOWLIST=… -s api`).

## Better Auth plugins

| Need | Plugin |
|---|---|
| GitHub / Google sign-in | Built-in social providers |
| Email login | Magic link, emailed with Resend (`RESEND_API_KEY`, `MAIL_FROM`; console in development) |
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

## Batele ID (connected)

Batele ID is available as a sign-in option ("Continue with Batele ID").

| Thing | Value |
|---|---|
| Plugin | Better Auth generic OAuth, provider ID `batele-id` (registered as a regular social provider) |
| Issuer / discovery | `https://api-v2.batele.plus/auth/.well-known/openid-configuration` (endpoints live on the API host, not `id.batele.plus`) |
| Client | `BATELE_ID_CLIENT_ID` (public PKCE client, no secret: `tokenEndpointAuth: none`) |
| Redirect URIs to register | `https://tracker-api.batele.plus/api/auth/callback/batele-id`, `http://localhost:4000/api/auth/callback/batele-id` |
| Profile | `/oidc/userinfo` (`sub`, `name`, `email?`, `picture?`), see `backend/api/src/batele-id.ts` |

- **Users without email:** Batele users can sign in by phone, but Better Auth needs an email. They get a placeholder `<sub>@users.batele-id.invalid`, which can never receive mail or match a real address.
- **Account linking:** automatic merging at sign-in is disabled (`disableImplicitLinking`), because Batele emails aren't verified. Users link Batele ID or GitHub explicitly from the home page while signed in (`linkSocial`); Batele ID and GitHub are listed as trusted providers so that explicit linking is allowed, and the linked account's email must match the user's.
- **Login page:** the web app asks `GET /auth/providers` which methods are configured and shows only those buttons.

Spider Tracker still acts as its own OAuth/OIDC provider for MCP, the CLI and third-party apps.
