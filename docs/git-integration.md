# Git and GitHub integration

[← Project overview](./PROJECT.md)

## Setup

- A **GitHub App** is installed per organization, and the organization chooses which repositories it can see.
- Selected repositories become `repos` and can be attached to projects and apps.
- Plain Git (not GitHub) works through webhooks and parsing commit messages.

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

GitHub webhooks → `backend/api` checks the signature and enqueues a job → `backend/worker` updates links and statuses and writes to the activity log.

## Later

- Optional two-way sync with GitHub Issues
- GitLab and Bitbucket support
