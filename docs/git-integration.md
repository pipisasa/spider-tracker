# Git and GitHub integration

[← Project overview](./PROJECT.md)

## Setup

- A **GitHub App** is installed per organization, and the organization chooses which repositories it can see.
- Selected repositories become `repos` and can be attached to projects and apps.
- Plain Git (not GitHub) works through webhooks and parsing commit messages.

## Linking work to tasks

- A branch name, commit message or pull request title or body containing a task key (`SPI-123`) links to that task.
- Branch names are generated from the task: `spi-123-short-title`.
- The task shows linked branches, commits and pull requests, plus pull request state, checks and reviews.

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
