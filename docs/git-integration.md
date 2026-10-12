# Git and GitHub integration

[← Project overview](./PROJECT.md)

## Setup

- A **GitHub App** is installed per organization, and the organization chooses which repositories it can see.
- Selected repositories become `repos` and can be attached to projects and apps.
- Plain Git (not GitHub) works through webhooks and parsing commit messages.

## GitHub App (ST-82)

One GitHub App serves the whole server; each organization installs it on the GitHub accounts it wants (Settings → GitHub). It is separate from GitHub sign-in (`GITHUB_CLIENT_ID`/`SECRET`, an OAuth App) and has its own settings.

### Server settings

`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`: **all or none** (the API refuses to start with only some; empty counts as unset). The private key is the PEM or its base64 encoding (one line; escaped `\n` newlines also work). Read only in `backend/api/src/env.ts` (`githubAppConfig`).

With none set the feature is off: `GET /github` answers `configured: false` and Settings → GitHub says GitHub isn't configured; `POST /github/install`, `POST …/sync` and the `/github/setup` callback answer `503 not_configured`. Repos can still be added by URL (ST-92), and existing installations can still be listed and disconnected.

### Install flow

1. An owner or admin (a person, signed in) clicks **Connect** in Settings → GitHub. `POST /v1/orgs/:org/github/install` returns `https://github.com/apps/<slug>/installations/new?state=…`.
2. `state` is signed (HMAC-SHA256 with a key derived from `BETTER_AUTH_SECRET`) and names the organization and the person; it expires after 15 minutes.
3. On GitHub they pick the account and repositories. Because the App has **Request user authorization (OAuth) during installation** on, GitHub sends them to the callback URL, `GET /github/setup?installation_id=…&setup_action=install&state=…&code=…`.
4. The callback checks, in order: the state's signature and expiry (`400`); a session (`401`); that the session's person started it and is still an owner or admin (`403`); then, with the OAuth `code`, that their GitHub account can access the installation (`GET /user/installations`). Anyone could type someone else's installation id, so the code is required: without it the result is `error=not_verified`.
5. It fetches the installation and its repositories with an installation token and saves them (`saveGithubInstallation` in core): repos the organization already has (same `owner/name`, any case) get `github_installation_id`; the others are added, attached to no project; repos it no longer grants keep their row and lose the installation. Then it redirects to `<WEB_ORIGIN>/<org>/settings/github?connected=<id>`, or `?error=<reason>` (`not_verified`, `no_access`, `missing_installation`, `not_found`, `other_organization`, `conflict`, `forbidden`, `github_unavailable`), or `?requested=1` when GitHub only sent an approval request to the account's owners.

A callback without our `state` (a change made from GitHub's side) just redirects to the web app; [webhooks](#webhooks-st-83) or **Sync** pick up such changes.

An installation belongs to **one organization**: connecting it from another is refused (`other_organization`). **Sync** (`POST …/github/installations/:id/sync`) fetches it again; **Disconnect** (`DELETE …/github/installations/:id`) forgets it (repos stay, without it) but leaves the App installed on GitHub: uninstall it there (`settingsUrl`).

### The GitHub bot

Git-driven changes (webhooks, ST-83 and later) are attributed to a per-organization **GitHub bot**: an actor with `type = integration`, handle `@github` (`@github-bot` if an older actor already had `@github`; `github` is now reserved), no user, no `agents` row and so no API keys. It is created when the first installation is connected (`ensureGithubBot`); `githubBotContext(tx, orgId)` gives its `ActorContext` with activity source `git`. It isn't offered in pickers: `GET /members` leaves it out (`?all=true`, used to name authors and assignees, includes it), it can't be assigned and mentions don't notify it.

### Webhooks (ST-83)

GitHub sends the App's events to `POST /webhooks/github` (`githubWebhookRoutes` in `backend/api/src/routes/github.ts`; handling in `@repo/core`'s `github-webhooks.ts`). Without the App's settings it answers `503 not_configured`, like the other GitHub routes.

1. **Size:** bodies over 5 MiB (`GITHUB_WEBHOOK_MAX_BYTES`) are `413`, before anything else is read.
2. **Signature:** `X-Hub-Signature-256` must be `sha256=` and the hex HMAC-SHA256 of the **raw body** with `GITHUB_APP_WEBHOOK_SECRET`, compared with `timingSafeEqual` (`verifyGithubSignature`); otherwise `401`. It is checked before the JSON is parsed, so the same JSON with other whitespace fails.
3. **Once per delivery:** in one transaction, `X-GitHub-Delivery` is inserted into `github_deliveries` first (`on conflict do nothing`). A redelivery, or copies arriving together (the second insert waits for the first transaction), finds the row and answers `{ "status": "duplicate" }` without doing anything. If handling fails, the transaction rolls back with the row, so a redelivery from GitHub is handled again.
4. **Organization:** the payload's `installation.id` names the installation; its organization's GitHub bot makes the changes (activity source `git`). Events of installations no organization has connected (for example `installation.created`, which usually arrives before the setup callback) are recorded and ignored.
5. **Payloads** are parsed with Zod, keeping only the fields used; a payload that doesn't match is `400` and isn't recorded.

| Event | Action | Effect |
|---|---|---|
| `ping` | | Recorded, nothing else (`ignored`). |
| `installation` | `created` | For an installation already connected (the setup callback came first): refreshes the account and grants the listed repos. |
| | `deleted` | Uninstalled on GitHub: the installation is forgotten (`github.uninstalled`); its repos stay, without it. |
| | `suspend`, `unsuspend` | Sets or clears `suspended` (`github.suspended`, `github.unsuspended`). |
| `installation_repositories` | `added`, `removed` | Added repos the organization has get the installation, the others are added (attached to no project, default branch `main` until a `repository` edit or **Sync**… see below); removed ones lose it and keep their row (`github.repos_changed`). A change of `repository_selection` is saved. |
| `repository` | `renamed`, `transferred` | Updates the repo's `owner/name` (`repo.updated`); ignored when the organization doesn't have the old name, or already has a row with the new one. |
| | `edited` | A new default branch updates `default_branch`. |

The response is `200 { "status": "processed" | "ignored" | "duplicate" }`. Other events (push, pull requests, …) are recorded and ignored until a handler exists: `githubEventHandlers` in core maps `X-GitHub-Event` to a handler that runs inside the delivery's transaction with the locked installation and the bot's context; ST-84 adds `push`, `create`, `delete` and `pull_request` there.

Webhook payloads don't carry a repository's default branch in `installation_repositories`, so a repo first seen there gets `main`. **Sync** (which asks GitHub) keeps an existing row's default branch; set it in Settings → Repos or with `spider repo update` if it differs.

### The GitHub port

The API talks to GitHub only through the `GithubApp` interface (`backend/api/src/github.ts`): `installUrl`, `userCanAccessInstallation`, `getInstallation`, `listInstallationRepos`. `createGithubApp` implements it with Octokit; tests use `createFakeGithub` (`github-fake.ts`) and never reach the network. Core never calls GitHub: it receives the installation and repositories as plain data. GitHub failures are `502 github_unavailable`.

### Manual checklist (a person)

Code can't do these; until they're done the feature stays off in production.

1. **Create the GitHub App** "Spider Tracker" (GitHub → Settings → Developer settings → GitHub Apps → New), owned by the account that will install it:
   - Homepage URL: `https://tracker.batele.plus`.
   - Callback URL: `https://tracker-api.batele.plus/github/setup`. Tick **Request user authorization (OAuth) during installation** (required: the callback uses the code to check the person can access the installation). Leave "Expire user authorization tokens" on.
   - Setup URL: leave empty (ignored when OAuth during installation is on).
   - Webhook: active, URL `https://tracker-api.batele.plus/webhooks/github`, secret from `openssl rand -hex 32` (the same value goes into `GITHUB_APP_WEBHOOK_SECRET`). GitHub Apps always send JSON.
   - Repository permissions: Metadata read, Contents read, Pull requests read and write (write is for ST-87's `spider pr`; read is enough until then), Checks read, Commit statuses read.
   - Events: Repository (handled from ST-83), plus Pull request, Pull request review, Push, Create, Delete, Check suite, Check run, Status (recorded and ignored until ST-84 and later handle them). `installation` and `installation_repositories` aren't in the list: GitHub sends them to every App.
   - Where can it be installed: only on this account.
2. **Generate a private key** (downloads a `.pem`). Note the App ID, the slug (from `github.com/apps/<slug>`), the Client ID, and generate a Client secret.
3. **Set the six variables on Railway** (service `api`), each through stdin so they stay out of shell history:
   ```bash
   base64 -i spider-tracker.*.private-key.pem | railway variable set GITHUB_APP_PRIVATE_KEY --stdin -s api
   printf %s '<app id>'         | railway variable set GITHUB_APP_ID --stdin -s api
   printf %s '<slug>'           | railway variable set GITHUB_APP_SLUG --stdin -s api
   printf %s '<webhook secret>' | railway variable set GITHUB_APP_WEBHOOK_SECRET --stdin -s api
   printf %s '<client id>'      | railway variable set GITHUB_APP_CLIENT_ID --stdin -s api
   printf %s '<client secret>'  | railway variable set GITHUB_APP_CLIENT_SECRET --stdin -s api
   ```
   Then delete the local `.pem`. Set all six together: with only some, the API refuses to start.
4. **Local development:** create a second App "Spider Tracker (dev)" with the callback `http://localhost:4000/github/setup` and its webhook pointed at a tunnel to `http://localhost:4000/webhooks/github` (smee.io or cloudflared). Put its six values in `backend/api/.env`.
5. If Cloudflare Access is ever put in front of the API, add a bypass for `/webhooks/github` (and keep `/github/setup` behind the normal sign-in).
6. **Deploy**, then in Settings → GitHub click **Connect**, pick `pipisasa/spider-tracker`, and attach the repo to ST under Settings → Repos (it was added by URL in ST-92, so it is linked, not duplicated).
7. Check that a `ping` delivery shows `200` (`{"status":"ignored"}`) under the App → Advanced → Recent deliveries. A `401` means `GITHUB_APP_WEBHOOK_SECRET` differs from the App's webhook secret; `503` means the API has no `GITHUB_APP_*` settings.

## Linking work to tasks

- A branch name, commit message or pull request title or body containing a task key (`SPI-123`) links to that task.
- Branch names are generated from the task: `spi-123-short-title` (see [Branch names](#branch-names)).
- The task shows linked branches, commits and pull requests, plus pull request state, checks and reviews.

## Branch names

`branchNameFor(key, title)` in `@repo/core/git` (browser-safe; used by `spider start` and the task page's "Copy branch name"):

- The lowercased key, a dash and the title in kebab case: `ST-12` "Fix the login" → `st-12-fix-the-login`.
- The title part is ASCII only and at most 40 characters: accents are dropped (`Café` → `cafe`), other scripts are removed, and a title with nothing left gives just `st-12`.

`spider start [KEY]` switches to that branch (creating it if needed, tracking `origin/<branch>` when only the remote one exists) unless the current branch already contains the key; see [interfaces.md](./interfaces.md).

## Finding keys

Also in `@repo/core/git`:

- `taskKeyFromBranch(branch)`: the first key in a branch name (`feat/st-12-x` → `ST-12`).
- `taskKeysIn(text)`: every key in a commit message, PR title or body: upper-cased, unique, in order. Keys are whole words (`xST-1` is `XST-1`, never `ST-1`; `ST-123` is never `ST-12`).
- `closingKeysIn(text)`: keys after a closing keyword: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` (any case, optional colon): `Fixes ST-12`, `closes: ST-3`.

Matching is syntactic: `UTF-8` and `SHA-256` look like keys. Link processing keeps only keys of the organization's existing projects.

## Status automation

Configurable per project. The defaults:

| Git event | Task status |
|---|---|
| Branch created / first commit | In Progress |
| Pull request opened | In Review |
| Pull request merged | Done |
| Pull request closed without merge | No change (it's logged) |

## Agents and Git

- Agents can create branches, push commits and open pull requests linked to the task.
- Pushing and merging can require a person's approval (see [agents.md](./agents.md#guardrails)).

## Processing

GitHub webhooks → `backend/api` checks the signature and handles the event inline, in one transaction, once per delivery ([ST-83](#webhooks-st-83); a worker can take this over later) → links, statuses and the activity log, attributed to the GitHub bot.

## Later

- Optional two-way sync with GitHub Issues
- GitLab and Bitbucket support
