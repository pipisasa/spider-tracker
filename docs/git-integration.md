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

A callback without our `state` (a change made from GitHub's side) just redirects to the web app; webhooks (ST-83) or **Sync** pick up such changes.

An installation belongs to **one organization**: connecting it from another is refused (`other_organization`). **Sync** (`POST …/github/installations/:id/sync`) fetches it again; **Disconnect** (`DELETE …/github/installations/:id`) forgets it (repos stay, without it) but leaves the App installed on GitHub: uninstall it there (`settingsUrl`).

### The GitHub bot

Git-driven changes (webhooks, ST-83 and later) are attributed to a per-organization **GitHub bot**: an actor with `type = integration`, handle `@github` (`@github-bot` if an older actor already had `@github`; `github` is now reserved), no user, no `agents` row and so no API keys. It is created when the first installation is connected (`ensureGithubBot`); `githubBotContext(tx, orgId)` gives its `ActorContext` with activity source `git`. It isn't offered in pickers: `GET /members` leaves it out (`?all=true`, used to name authors and assignees, includes it), it can't be assigned and mentions don't notify it.

### The GitHub port

The API talks to GitHub only through the `GithubApp` interface (`backend/api/src/github.ts`): `installUrl`, `userCanAccessInstallation`, `getInstallation`, `listInstallationRepos`. `createGithubApp` implements it with Octokit; tests use `createFakeGithub` (`github-fake.ts`) and never reach the network. Core never calls GitHub: it receives the installation and repositories as plain data. GitHub failures are `502 github_unavailable`.

### Manual checklist (a person)

Code can't do these; until they're done the feature stays off in production.

1. **Create the GitHub App** "Spider Tracker" (GitHub → Settings → Developer settings → GitHub Apps → New), owned by the account that will install it:
   - Homepage URL: `https://tracker.batele.plus`.
   - Callback URL: `https://tracker-api.batele.plus/github/setup`. Tick **Request user authorization (OAuth) during installation** (required: the callback uses the code to check the person can access the installation). Leave "Expire user authorization tokens" on.
   - Setup URL: leave empty (ignored when OAuth during installation is on).
   - Webhook: active, URL `https://tracker-api.batele.plus/webhooks/github` (handled from ST-83), secret from `openssl rand -hex 32`.
   - Repository permissions: Metadata read, Contents read, Pull requests read and write (write is for ST-87's `spider pr`; read is enough until then), Checks read, Commit statuses read.
   - Events: Pull request, Pull request review, Push, Create, Delete, Check suite, Check run, Status, Repository.
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
4. **Local development:** create a second App "Spider Tracker (dev)" with the callback `http://localhost:4000/github/setup` and, from ST-83, its webhook pointed at a tunnel (smee.io or cloudflared). Put its six values in `backend/api/.env`.
5. If Cloudflare Access is ever put in front of the API, add a bypass for `/webhooks/github` (and keep `/github/setup` behind the normal sign-in).
6. **Deploy**, then in Settings → GitHub click **Connect**, pick `pipisasa/spider-tracker`, and attach the repo to ST under Settings → Repos (it was added by URL in ST-92, so it is linked, not duplicated).
7. From ST-83: check that a `ping` delivery shows `200` under the App → Advanced → Recent deliveries.

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

GitHub webhooks → `backend/api` checks the signature and handles the event inline, in one transaction (ST-83; a worker can take this over later) → links, statuses and the activity log, attributed to the GitHub bot.

## Later

- Optional two-way sync with GitHub Issues
- GitLab and Bitbucket support
