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
2. `state` is signed (HMAC-SHA256 with a key derived from `BETTER_AUTH_SECRET`) and names the organization, the person and a random nonce; it expires after 15 minutes and works **once** (ST-137): the nonce is stored in `github_install_states` when the link is issued and deleted by the callback that uses it, so a state copied from browser history or access logs can't be replayed. Expired rows are deleted whenever a new link is issued. Rotating `BETTER_AUTH_SECRET` (which also signs people out) invalidates install links in flight too: whoever was installing starts again from Settings → GitHub.
3. On GitHub they pick the account and repositories. Because the App has **Request user authorization (OAuth) during installation** on, GitHub sends them to the callback URL, `GET /github/setup?installation_id=…&setup_action=install&state=…&code=…`.
4. The callback checks, in order: the state's signature and expiry (`400`); a session (`401`); that the session's person started it (`403`); that it wasn't used yet, using it up (`400`); that they are still an owner or admin (`403`); then, with the OAuth `code`, that their GitHub account can access the installation (`GET /user/installations`). Anyone could type someone else's installation id, so the code is required: without it the result is `error=not_verified`.
5. It fetches the installation and its repositories with an installation token and saves them (`saveGithubInstallation` in core): repos the organization already has (same `owner/name`, any case) get `github_installation_id`; the others are added, attached to no project; repos it no longer grants keep their row and lose the installation. Then it redirects to `<WEB_ORIGIN>/<org>/settings/github?connected=<id>`, or `?error=<reason>` (`not_verified`, `no_access`, `missing_installation`, `not_found`, `other_organization`, `conflict`, `forbidden`, `github_unavailable`), or `?requested=1` when GitHub only sent an approval request to the account's owners.

A callback without our `state` (a change made from GitHub's side) just redirects to the web app; [webhooks](#webhooks-st-83) or **Sync** pick up such changes.

When GitHub fails or refuses a request, the API logs one line: the step, the HTTP status, and the method and URL without the query (`logGithubFailure`). `GithubUnavailableError` keeps no `cause`: Octokit's error carries the request, and the OAuth code exchange's body holds the App's client secret and the person's code (ST-137).

An installation belongs to **one organization**: connecting it from another is refused (`other_organization`; core throws `GithubInstallationTakenError`, a `conflict`). **Sync** (`POST …/github/installations/:id/sync`) fetches it again; **Disconnect** (`DELETE …/github/installations/:id`) forgets it (repos stay, without it) but leaves the App installed on GitHub: uninstall it there (`settingsUrl`).

### The GitHub bot

Git-driven changes (webhooks, ST-83 and later) are attributed to a per-organization **GitHub bot**: an actor with `type = integration`, handle `@github` (`@github-bot` if an older actor already had `@github`; `github` is now reserved), no user, no `agents` row and so no API keys. It is created when the first installation is connected (`ensureGithubBot`); `githubBotContext(tx, orgId)` gives its `ActorContext` with activity source `git`. It isn't offered in pickers: `GET /members` leaves it out (`?all=true`, used to name authors and assignees, includes it), it can't be assigned and mentions don't notify it.

### Webhooks (ST-83)

GitHub sends the App's events to `POST /webhooks/github` (`githubWebhookRoutes` in `backend/api/src/routes/github.ts`; handling in `@repo/core`'s `github-webhooks.ts`). Without the App's settings it answers `503 not_configured`, like the other GitHub routes.

1. **Size:** bodies over 25 MiB (`GITHUB_WEBHOOK_MAX_BYTES`, GitHub's own cap, so a large `push` isn't lost) are `413`, before anything else is read, streamed (chunked) bodies included. A refused delivery is logged with its delivery id, event and `Content-Length`, never the body (ST-138).
2. **Signature:** `X-Hub-Signature-256` must be `sha256=` and the hex HMAC-SHA256 of the **raw body** with `GITHUB_APP_WEBHOOK_SECRET`, compared with `timingSafeEqual` (`verifyGithubSignature`); otherwise `401`. It is checked before the JSON is parsed, so the same JSON with other whitespace fails.
3. **Once per delivery:** in one transaction, `X-GitHub-Delivery` is inserted into `github_deliveries` first (`on conflict do nothing`). A redelivery, or copies arriving together (the second insert waits for the first transaction), finds the row and answers `{ "status": "duplicate" }` without doing anything. If handling fails, the transaction rolls back with the row, so a redelivery from GitHub is handled again. **Retention (ST-138):** rows are kept 30 days (`GITHUB_DELIVERY_RETENTION_DAYS`); after each new delivery the endpoint deletes up to 500 older ones (`pruneGithubDeliveries`, by `received_at`, skipping rows another prune holds), so the table stays bounded without a scheduler. GitHub only redelivers recent deliveries, so dropping old ids doesn't let one be handled twice.
4. **Organization:** the payload's `installation.id` names the installation; its organization's GitHub bot makes the changes (activity source `git`). Events of installations no organization has connected (for example `installation.created`, which usually arrives before the setup callback) are recorded and ignored.
5. **Payloads** are parsed with Zod, keeping only the fields used; a payload that doesn't match is `400` and isn't recorded.

| Event                       | Action                   | Effect                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`                      |                          | Recorded, nothing else (`ignored`).                                                                                                                                                                                                                                                          |
| `installation`              | `created`                | For an installation already connected (the setup callback came first): refreshes the account and grants the listed repos.                                                                                                                                                                    |
|                             | `deleted`                | Uninstalled on GitHub: the installation is forgotten (`github.uninstalled`); its repos stay, without it.                                                                                                                                                                                     |
|                             | `suspend`, `unsuspend`   | Sets or clears `suspended` (`github.suspended`, `github.unsuspended`).                                                                                                                                                                                                                       |
| `installation_repositories` | `added`, `removed`       | Added repos the organization has get the installation, the others are added (attached to no project, default branch `main` until a `repository` edit or **Sync**… see below); removed ones lose it and keep their row (`github.repos_changed`). A change of `repository_selection` is saved. |
| `repository`                | `renamed`, `transferred` | Updates the repo's `owner/name` (`repo.updated`); ignored when the installation doesn't grant a repo with the old name (repos added by URL only, or granted by another installation, are left alone; ST-138), or the organization already has a row with the new one.                        |
|                             | `edited`                 | A new default branch updates `default_branch` (the installation's repos only).                                                                                                                                                                                                               |
| `create`                    | branch                   | Links a branch named after a task to it ([Linking work to tasks](#linking-work-to-tasks-st-84)); tags are ignored.                                                                                                                                                                           |
| `delete`                    | branch                   | Marks the branch's links deleted (they stay).                                                                                                                                                                                                                                                |
| `push`                      |                          | Links the branch (by its name) and its commits (by their messages, and the branch's key); a push that deletes the branch marks it deleted. Tags are ignored.                                                                                                                                 |
| `pull_request`              | any                      | Saves the pull request (unless the event is stale) and links it by its branch, title and body.                                                                                                                                                                                               |

The response is `200 { "status": "processed" | "ignored" | "duplicate" }`. Other events (reviews, checks, statuses, …) are recorded and ignored until a handler exists: `githubEventHandlers` in core maps `X-GitHub-Event` to a handler that runs inside the delivery's transaction with the locked installation and the bot's context.

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
   - Repository permissions: Metadata read, Contents read, Pull requests read and write (write lets `spider pr` and MCP `open_pull_request` open pull requests, ST-87), Checks read, Commit statuses read.
   - Events to subscribe to now: **Repository** (handled from ST-83), **Create**, **Delete**, **Push** and **Pull request** (handled from ST-84). Pull request review, Check suite, Check run and Status can be ticked too; they are recorded and ignored until ST-86 handles them. `installation` and `installation_repositories` aren't in the list: GitHub sends them to every App.
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

## Linking work to tasks (ST-84)

Branches, commits and pull requests link to tasks from the [webhooks](#webhooks-st-83) (`git-links.ts` in core). A key counts only when the task exists (not deleted) and **its project is attached to the repo** (Settings → Repos, `spider repo attach`); that also drops look-alikes such as `UTF-8`. Repos the organization doesn't have are ignored.

| From                                        | Linked to                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A branch (`create`, or a `push` to it)      | The task in its name (`taskKeyFromBranch`): `st-12-fix-login` → ST-12.                                             |
| A commit (`push`)                           | Every task its message names, and the branch's task when the commit is new to the repo (`distinct` isn't `false`). |
| A pull request (`pull_request`, any action) | The task in its head branch's name, and every task its title or body names.                                        |

Each link records **how** the key was found (`via`), the strongest when several match: `closing` (a closing keyword, `Fixes ST-12`, in a commit message or PR title or body), `branch`, `title`, `body`, `message`. A commit seen again with a stronger match (the same commit on `main` with "Fixes ST-12") is upgraded, never downgraded. [Status automation](#status-automation-st-85) acts only on `closing`, `branch` and `title`.

- **Merges into a task branch (ST-143):** a push lists every commit of its `before..after` range, so merging `main` into `st-12-…` lists main's commits too. GitHub marks those `distinct: false` (already pushed to another branch), and the branch's key links only distinct commits, so main's work isn't linked to ST-12; keys in those commits' own messages still link them.
- **Force pushes:** commits of the history a force push replaced stay linked (their GitHub URLs may stop working once GitHub drops them).
- **Branches** stay linked when deleted on GitHub (`delete`, or a `push` with `deleted`); they are shown as deleted, and live again if pushed again.
- **Detached repos:** links are kept when a repo is detached from a project, but a task shows only the links in repos attached to its project (`getTaskGit`); attaching the repo again shows them again.
- **Pull requests** are stored in `pull_requests` (only those that link to a task). Their links follow the latest title, body and branch: an edit that drops a key removes that task's link. The state is `open` (with `draft`), `closed` (without merging) or `merged`.
- **Out of order:** GitHub doesn't guarantee delivery order. An event whose `pull_request.updated_at` is older than the stored PR's changes nothing (`ignored`); `merged` is final; with the same `updated_at` the state never goes back (closed stays closed until a later reopen).
- Each change publishes `task.git` (realtime), so an open task page refreshes its Development panel.
- No activity entries are written for links; the task's git links are the record.

**Status automation (ST-85)** runs as `automatePullRequest` (`git-automation.ts`), called from `git-links.ts` in the delivery's transaction after the PR and its links are saved (never for stale events), with the action, the PR before and after, and the linked tasks with `via`; see [Status automation](#status-automation-st-85).

**Reading:** `GET /v1/orgs/:org/tasks/:key/git` returns `TaskGitDto`: `pullRequests` (recently updated first), `branches` and `commits` (newest first, the latest 100), each with the repo's `owner/name` and a GitHub URL built from the repo's current name. Also `client.tasks.git` (SDK), MCP `get_task_git`, `spider task git [key]`, and the **Development** panel on the task page. Project settings list the project's repos.

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

Matching is syntactic: `UTF-8` and `SHA-256` look like keys. Link processing keeps only keys of existing tasks in projects attached to the repo.

## Status automation (ST-85)

A `pull_request` event moves the tasks the PR is linked to, with no manual step: open a PR for `st-12-…` and ST-12 goes to In Review; merge it and ST-12 is Done. Configurable per project (`projects.git_automation`, null = the defaults); each event names a status **category**, and the task moves to the first status of that category (board order) in its own project's task workflow.

| Pull request event                                         | Setting  | Default                     |
| ---------------------------------------------------------- | -------- | --------------------------- |
| Opened as a draft, or converted to a draft                 | `draft`  | In Progress (`in_progress`) |
| Opened (not a draft), reopened, or marked ready for review | `opened` | In Review (`in_review`)     |
| Merged into the repo's default branch                      | `merged` | Done (`done`)               |
| Closed without merging                                     | `closed` | No change (`null`)          |

`enabled: false` turns it off for the project. Other actions (`edited`, `synchronize`, …) move nothing.

Rules (`decideTransition` and `pullRequestEvent` in `@repo/core/git-automation-rules`, browser-safe):

- **Which links:** only a closing keyword, the head branch or the title (`via` `closing`, `branch`, `title`). A key mentioned only in the PR body links the PR but doesn't move the task.
- **Which tasks:** only kind `task`, in projects that aren't archived; releases and milestones never move (ST-93 ships releases separately; Done means finished, not shipped).
- **Which base:** a merge counts only when the PR's base is the repo's default branch (`repository.default_branch` in the payload, else the repo's stored one). A merge into another branch (a stacked PR into its parent's branch, a release or feature branch) moves nothing: the work hasn't reached the default branch yet, and the task stays where it is (usually In Review) until a PR naming it is merged into the default branch. Opened, ready and draft events count whatever the base: the work is in progress or in review either way.
- **Whose PRs:** only trusted PRs move tasks (`trustedPullRequest`): the head branch is in the repo itself (`pull_request.head.repo.full_name` equals the repo; not a fork, nor a deleted one), and the author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`, or the author is **our own App's bot** (`user.type` `Bot` and `user.login` `<GITHUB_APP_SLUG>[bot]`; its PRs from `spider pr` have the association `NONE`). The API passes the slug from its config into core (`handleGithubWebhook({ appSlug })`). Other bots (Dependabot, Renovate, other Apps) are never trusted, whatever their association (ST-141): their PR bodies quote upstream release notes, and an upstream "Fixes API-12" would otherwise close our API-12 on merge. Other PRs (from forks, drive-by contributors on a public repo, other bots) are still saved and linked, but move nothing.
- **Outside contributors (a product choice, ST-141):** trust depends only on the PR's author, not on who merges it. A maintainer merging an outside contributor's PR (or a Dependabot PR) doesn't move its tasks; they are moved by hand. Accepting a `merged` event on the merge alone (a trusted `sender`) was considered and left out: anyone with merge rights could then close tasks named in an untrusted body. A PR opened through `spider pr` (ST-87) is trusted: its head is always a branch of the repo and the person or agent asking may write to the task.
- **Forward only:** a task never moves back in its workflow (by category: backlog, todo, in progress, in review, done/canceled), and a done or canceled task stays. The one exception: a draft event moves a task from the `opened` category (In Review) back to the `draft` one (In Progress), unless another linked PR is open and ready.
- **Several PRs:** a closing move (merged → Done) waits until no other PR linked to the task (by closing keyword, branch or title) is open.
- **Who:** the change is the @github bot's, with activity source `git`, through the same `applyTaskUpdate` as a manual change (activity, `completedAt`, realtime). The activity entry's `changes` also has `pullRequest: { number, event, sender }`, where `sender` is the GitHub login whose action sent the event (who merged, for a merge; the App's bot for `spider pr`), so a Done move can be traced to a person or agent; the task page shows it ("moved In Review → Done (pull request #12 merged by ann)").
- **Redeliveries:** a delivery id seen before is `duplicate` and changes nothing (ST-83), so GitHub redelivering an event never moves a task twice.
- **Out of order:** stale events are ignored before automation runs (see above), and a late `opened` for a merged PR moves nothing.

Settings: `PATCH /v1/orgs/:org/projects/:key` with `gitAutomation` (only the fields given change; `null` resets to the defaults), MCP `update_project`, `spider project update KEY --automation on|off|defaults --on-draft|--on-opened|--on-merged|--on-closed <category|none>`, and **Status automation** in the web app's project settings. `ProjectDto.gitAutomation` always has every field, defaults filled in.

## Opening pull requests (ST-87)

`spider pr` opens the task's pull request without leaving the terminal; the API opens it on GitHub as the App, so it works the same for people and agents.

1. **Push** (CLI only): `git push --set-upstream origin <current branch>` with the person's own git and credentials (the injected `git` runner, `pushBranch` in `backend/cli/src/git.ts`). `--no-push` skips it for a branch already pushed. A failed push stops before the API (exit 1). It never pushes the origin's default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`; `main` and `master` when git doesn't know it) or the `--base` branch, and pushes only a branch whose key is the task's (`taskKeyFromBranch`) unless `--any-branch` is given; otherwise it exits 2 before pushing (ST-144).
2. **Open:** `POST /v1/orgs/:org/tasks/:key/pull-request` (`openTaskPullRequest` in `packages/core/src/pull-request-open.ts`). The API's GitHub port (`createPullRequest` in `backend/api/src/github.ts`) calls `POST /repos/{owner}/{repo}/pulls` with the repo's installation token.
3. **Link at once:** the answer is saved with the webhook code (`savePullRequest` in `git-links.ts`) as an `opened` event from the @github bot, so the task's Development panel shows it and [status automation](#status-automation-st-85) moves the task (In Review, or In Progress for a draft) right away. Only the task asked for moves now (`automateOnly`); other tasks the PR names are linked, and GitHub's own `pull_request` event, arriving later, may move them like any PR's.

Rules:

- **Task:** the key given, or the current branch's (CLI). Guests can't (`403`); a scoped agent only in its projects (`404` otherwise).
- **Other keys (ST-144):** every task the head branch, title or body names (`pullRequestKeys`) in a project attached to the repo is linked, and moved by GitHub's later events, as the @github bot. So each must be in the caller's projects: otherwise the request is `404`, with a message that names no key, before GitHub is asked. Keys that aren't tasks of attached projects ("UTF-8") don't count.
- **Repo:** one of the repos attached to the task's project: the one named (`repo`; the CLI sends the folder's `origin` remote, or `--repo owner/name`), or the only one. None attached, several without a name, or one not attached is `400`; so without `--repo`, the CLI's `origin` remote must be attached to the project, even when it has only one repo. The repo must be granted to a connected, unsuspended installation of the same organization (`400` otherwise).
- **Branches:** `head` defaults to the CLI's current branch, else the task's branch (`branchNameFor`); `base` to the repo's default branch. `head` equal to `base` is `400`.
- **Title and body:** the title defaults to `<task title> (KEY)`; the body to a link to the task. The body always closes the task: `Closes KEY` is appended unless it already has a closing keyword for it, so merging the PR moves the task to Done.
- **Already open:** a PR open for the head branch is `409 conflict` with `error.url` (the PR's address; in the message too). It is found in `pull_requests` first, without asking GitHub; when only GitHub knows it (its 422 "A pull request already exists"), it is fetched, linked when it names the task (as `edited`: nothing moves) and reported the same way.
- **GitHub refusing it** (422: no commits between the branches, a branch that isn't pushed) is `400` with GitHub's reason; GitHub unreachable or refusing otherwise (no `Pull requests: write`) is `502 github_unavailable`. Without the App, `503 not_configured`.

MCP `open_pull_request` does steps 2 and 3 for a branch already pushed (agents on MCP can't push) and returns the same JSON as `spider pr --json`: `OpenedPullRequestDto` `{ taskKey, pullRequest }`.

## Agents and Git

- Agents can create branches, push commits and open pull requests linked to the task (`spider pr`, or MCP `open_pull_request` after pushing).
- Pushing and merging can require a person's approval (see [agents.md](./agents.md#guardrails)).

## Processing

GitHub webhooks → `backend/api` checks the signature and handles the event inline, in one transaction, once per delivery ([ST-83](#webhooks-st-83); a worker can take this over later) → links, statuses and the activity log, attributed to the GitHub bot.

## Later

- Optional two-way sync with GitHub Issues
- GitLab and Bitbucket support
