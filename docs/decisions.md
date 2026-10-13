# Decisions

[← Project overview](./PROJECT.md)

Short records of technology choices. Add new ones at the bottom.

---

## 1. SQL over NoSQL

**Decision:** use a relational database.

**Why:**
- The data is deeply relational: organizations → projects → tasks → assignees, tags, relations, repos, pull requests and runs.
- Saved views are ad-hoc filters across many fields, which SQL handles naturally. A document store would need every access pattern planned in advance, plus duplicated data.
- Status changes, activity entries and run updates must commit together, which needs transactions.
- Reporting (cycle stats, agent cost, throughput) is plain SQL.

**Flexible data** (custom fields, run traces) goes into Postgres `JSONB` columns, so NoSQL brings no extra benefit.

---

## 2. Postgres over SQLite

**Decision:** Postgres on the server. SQLite only on clients, later.

**Why:**
- Agents, webhooks, workers and people all write at the same time. Postgres handles that well; SQLite allows only one writer at a time.
- The API and the worker run on different machines and need one shared database over the network.
- Row-level security gives organization isolation inside the database.
- Built-in change notifications (LISTEN/NOTIFY) power live updates.
- `JSONB` + GIN indexes, full-text search, pgvector and pg_cron.

**SQLite fits:** a local cache in the CLI or a desktop app, a single-user self-hosted mode, and scratch state during an agent run.

**Tests** run against real Postgres, not SQLite.

---

## 3. TypeScript (Node/Bun) over Elixir

**Decision:** a TypeScript backend.

**Why:**
- Agent tooling is strongest in TypeScript. The Claude Agent SDK, the MCP SDK and Octokit are all official and complete there. Elixir has only community libraries for these.
- One language across web, API, SDK and CLI, with shared types and Zod schemas.
- The workload waits on the database, GitHub and LLM calls, not CPU, so Node-style async handles it fine.

**Elixir's strengths** (supervised processes, Phoenix realtime, Oban) are real but don't outweigh the ecosystem gap for an agent-first product. A mixed Elixir + Node setup was rejected as too much overhead.

---

## 4. Separate API and worker, not framework API routes

**Decision:** `backend/api` (Hono) and `backend/worker` run as their own services.

**Why:** agent runs take minutes (beyond serverless time limits), webhooks need retries, and the public API is a first-class product rather than a frontend detail.

---

## 5. No message broker yet

**Decision:** Postgres provides the job queue (pg-boss or Graphile Worker) and live updates (LISTEN/NOTIFY, streamed to browsers over SSE).

**Revisit when:**
- many workers need to fan out high-frequency token streams,
- Postgres notifications become a bottleneck (they're capped at about 8KB per message), or
- the system grows into many separate services.

Then consider NATS or Redis Streams. External agents never connect to the broker directly; they always go through the API (MCP, WebSocket or SSE).

---

## 6. Bun as runtime and package manager

**Decision:** Bun for installs, scripts and backend runtime, inside a Turborepo monorepo.

**Why:** fast installs and startup, native TypeScript, and the same setup as other personal projects. Backend apps extend `@repo/typescript-config/bun.json`.

---

## 7. Better Auth for authentication

**Decision:** Better Auth, running inside `backend/api`, instead of Supabase Auth. Spider Tracker acts as its own OAuth 2.1 / OIDC provider. Details: [auth.md](./auth.md).

**Why:**
- MCP clients and the CLI must sign in to *us*, so we need an OAuth server, a device flow and API keys. Better Auth has plugins for all of them.
- It's TypeScript, runs in Hono on Bun, and stores its tables in our Postgres through Drizzle.
- Identity stays in our own database, with no separate auth schema.

**Trade-off:** no Supabase `auth.uid()` in database access rules. The API sets `app.org_id` and `app.actor_id` for each transaction, and the access rules read those instead.

**Batele ID:** added as an extra sign-in provider (generic OAuth, `batele-id`), without replacing our own provider. See [auth.md](./auth.md#batele-id-connected).

---

## 8. Vite SPA with TanStack Router and Query, not Next.js

**Decision:** `web/app` is a Vite + React single-page app using TanStack Router (type-safe routing) and TanStack Query (server state and caching), served as static files.

**Why:**
- The app sits behind login, so server rendering and SEO bring nothing. A marketing site can be separate later.
- All data comes from our public API (API parity); the frontend needs no server code of its own.
- Static files host cheaply anywhere (Cloudflare Pages) with no server runtime.
- TanStack Query's cache fits optimistic updates and applying realtime events.
- Fast Vite dev server and builds; no framework lock-in.

**Trade-off:** no server rendering; the first load shows a loading shell. That's acceptable for a logged-in tool.

---

## 9. No Supabase: Railway Postgres, Cloudflare Pages and R2

**Decision:** Postgres and the backend run on Railway; the frontend on Cloudflare Pages; file storage on Cloudflare R2.

**Why:**
- After choosing Better Auth, Supabase would only provide Postgres, Realtime and storage. Each has a simple replacement, and fewer vendors means less to manage.
- Postgres sits next to the API and worker on Railway's private network: low latency, no public database endpoint.
- R2 is S3-compatible with no download (egress) fees, and is already used for `cdn.batele.plus`.
- Cloudflare Pages serves the static SPA from the edge.

**Replacements:**
- Realtime → LISTEN/NOTIFY + SSE from `backend/api` (see [architecture.md](./architecture.md#realtime)).
- Storage → R2 with presigned URLs.
- Database backups → Railway backups, plus scheduled `pg_dump` to R2.

**Trade-off:** we build and run the realtime layer ourselves.

---

## 10. Private access through Cloudflare Access

**Decision:** while the project is private, `tracker.batele.plus` and `tracker-api.batele.plus` sit behind Cloudflare Access. Setup: [architecture.md](./architecture.md#private-access-for-now).

**Why:**
- The domain and frontend are already on Cloudflare, so there's nothing extra to run.
- It works the same for browsers, the CLI and agents (service tokens), and allows path exceptions for GitHub webhooks.
- It's a gate in front of the app, independent of Better Auth, and can be removed when the project goes public.

**Alternative considered: Tailscale.** Gives no public surface at all, but:
- Railway containers would need `tailscaled` running inside them (userspace mode), plus TLS certificates via DNS challenge.
- GitHub webhooks couldn't reach a tailnet-only API without Tailscale Funnel or a separate public receiver.
- Every agent and CI machine would have to join the tailnet.

Revisit Tailscale if the API must have no public endpoint at all.

---

## 11. HTML documents render in a fully sandboxed iframe

**Decision:** HTML documents are shown in `<iframe sandbox="" srcdoc=…>`: no `allow-scripts`, no `allow-same-origin`, no forms or popups. Markdown documents are rendered with react-markdown and raw HTML inside Markdown is skipped.

**Why:**
- Documents are written by people and agents alike; an agent could be prompt-injected into writing hostile HTML. With an empty `sandbox`, the frame gets a unique opaque origin, can't run scripts and can't reach the app, its cookies or the API.
- No HTML sanitizer to keep up to date, and documents still render exactly as written (styles, tables, layout).

**Trade-off:** no interactive HTML (scripts, forms), and the frame can't size itself to its content, so it gets a fixed, resizable height. Revisit with a separate sandbox origin if interactive reports are ever needed.

**Avatar credits:** generated avatars use the DiceBear styles Notionists (CC0) and Bottts (by Pablo Stanley, free for personal and commercial use), rendered locally with @dicebear 9.4.3.

---

## 12. Project rules are a pointer to a project document

**Decision:** a project's rules for agents (ST-111) are a nullable `projects.rules_document_id` pointing at one of the project's own project-level documents, not a flag on documents or a separate text field.

**Why:**
- "At most one per project" is the column itself; no partial unique index, and replacing the rules is one update.
- The rules stay a normal document: versions, links, the editor and the API all work unchanged.
- Agents get them through the MCP server's instructions on `initialize`, which every MCP session (plugin or `spider claude`) reads first, so neither the generated agent file nor the channel has to be regenerated when they change.
- Changes are inbox items of a new kind `rules` about a document (`inbox_items.task_id` became nullable, with a `document_id`). Clients from before it expect a task on every item, so the API returns `rules` items only when `kinds` asks for them.

**Trade-off:** rules belong to one project; organization-wide rules shared by several projects would need a different shape.

---

## 13. Document comments share the comments table with task comments

**Decision:** comments on documents (ST-118) are rows of the existing `comments` table: `task_id` became nullable next to a new `document_id`, with a check that exactly one is set (as ST-111 did for `inbox_items`). Document-only columns are `quote` (the fragment a top-level comment is about), `document_version` and `resolved_at` / `resolved_by`. Their notifications are new inbox kinds `document_mention`, `document_reply` and `document_comment` about a document.

**Why:**
- One pipeline: mentions, the agent loop guard, soft delete and `inbox_items.comment_id` (which shows the comment's body in the inbox and the channel) work for both without a second table or a second foreign key on inbox items.
- Task comment queries filter on `task_id` already, so they are unaffected; only the inbox joins learned that a document may have no project.
- New inbox kinds instead of reusing `mention` / `reply` / `comment`: clients from before ST-111 expect a task on every item of those kinds, and the API returns the new kinds only when `kinds` asks for them.
- Anchors are the quoted text, not offsets: a quote survives edits elsewhere in the document, and `outdated` is computed when read (the quote no longer occurs in the current content, compared on letters and digits only so Markdown or HTML markup doesn't matter). Nothing has to be rewritten on save.

**Trade-off:** a quote that occurs twice anchors to its first occurrence, and a fragment that is changed and later changed back is no longer outdated. HTML documents render in a sandboxed frame (decision 11), so the web app can't highlight or select fragments in them; their fragment comments come through the API, CLI or MCP.

---

## 14. Workflows per project and task kind; `statuses` stays the task workflow

**Decision:** statuses get a `kind` (ST-90), so each project has one workflow per task kind (task, release, milestone), and a task's kind is fixed at creation. The database enforces that a task's status is of its project and kind with a composite foreign key. In API responses, `ProjectDetailDto.statuses` keeps meaning the task workflow, and the new `workflows` field holds every kind's.

**Why:**
- Releases and milestones need their own steps (On staging, Release review; Active, Ready to close) while code, agents and skills keep using only the fixed categories.
- Keeping `statuses` as the task workflow means CLIs and scripts from before kinds still resolve "Done" or `in_progress` to the task statuses; mixing every kind into it would make them pick a milestone's Done (its position is lower).
- A fixed kind means no status remapping when a task changes kind; a composite foreign key makes a wrong-kind status impossible even for writes that bypass core.
- Deleting a status moves its tasks first (the caller picks the target) instead of refusing while tasks use it, and every workflow keeps an open and a done status so tasks can always start and finish. Categories can't change, so `completedAt` only moves when tasks move.

**Trade-off:** `statuses` and `workflows.task` repeat the same list in every project response. Status names in list filters without a kind match in every workflow (names before categories), so `--status Done` finds done tasks and done milestones.

## 15. A release is a task; shipping is a property of Done tasks, not a status

**Decision:** releases (ST-93) are tasks of kind `release`, with their own workflow, and included tasks point at their release with `tasks.release_id` (one release per task). Shipping is stored on the task (`shipped_at`, set when its release enters the done category) and shown as a derived `shipping` state (`not_in_release`, `in_release`, `shipped`, `no_code`), never as a status: Done means finished, and an included task's status never changes when it ships. A Done task with nothing to ship is marked with an explicit `no_code` flag.

**Why:**
- A release needs what tasks have (status, owner, dates, comments, documents, activity, the board), so it reuses them instead of a parallel entity.
- A status per shipping step would mix two questions (is the work finished? is it in production?) in one workflow and force every project's task workflow to grow release steps.
- `shipped_at` on each task keeps "when did this reach users" readable without a join, and lets a release's status move back (Released → Release review) by clearing it.
- "No code" can't be derived yet: commits are linked to tasks only in a later step (ST-84). An explicit flag is the conservative choice; once commits are linked, "no commits and no apps" can be its default.
- Releasing refuses while an included task isn't Done, and canceling or deleting a release takes its tasks out, so `release_id` always points at a release that can still ship them.
- Agents can move a release to Released, like people: shipping only sets `shipped_at` and never changes an included task's status, so the rule that only a person marks tasks Done holds. Since ST-94 Released is gated by deployments (every app with environments in production). A project-scoped agent makes the moves that write to every included task (Released, back out of it, Canceled, delete) only when it can see all of them; otherwise it is refused without naming the hidden tasks. Activity on included tasks stores the release's id, resolved for each reader, so a release the reader can't see isn't named.

**Trade-off:** `release_id` is a self-reference on `tasks`, so the database can't check that it points at a release or that the task is Done; core enforces both. A task reopened after it was added stays in the release and blocks Released until it is Done again.

## 16. Release changelogs come from handoff notes, are written on request, and git checks run locally

**Decision:** a release's changelog (ST-95) is generated from its included tasks: the title plus the "What changed" section of the task's handoff note, the latest comment with such a section by one of the task's assignees, else by anyone. It is written into the release's description only on request (`spider release changelog --write`, MCP `get_release_changelog` with `write`), between markers whose hash records what was written; a hand-edited block is never replaced without `force`. Grouping by app and the git check (`spider release check`) run in the CLI on local `git log`; CHANGELOG.md and GitHub release notes are CLI steps too (`spider release notes`).

**Why:**
- Handoff comments already carry a **What changed** section by convention (the tasks skill now asks for it), so no new field is needed; preferring the assignee's latest note skips reviewers' summaries and older drafts, and falling back to anyone keeps reassigned work.
- An explicit write keeps the description editable: automatic regeneration on every task change would overwrite the release owner's wording. The hash notices edits without storing a second copy.
- The server has no clone of the repo and no permission to push tags or create GitHub releases, and commit links (ST-84) aren't there yet. The local clone has everything, and every git call goes through the CLI's injected runner, so tests fake it.
- Keys count from commit subjects, closing keywords and merged branch names only: commit bodies often mention other tasks ("the seam for ST-84").
- The description is readable by everyone who can see the release, so the changelog never publishes other projects' data: it holds only the tasks of the release's own project and its apps in repos attached to that project. Included tasks of other projects are left out, even when the writer can see them (they are listed in their own project's releases' changelogs, or written by hand). This also makes the changelog the same for every reader. A project-scoped writer is refused when the release includes tasks it can't see.

**Trade-off:** a multi-app changelog written over MCP isn't grouped by app (the server can't tell which task touched which app) until ST-84 links commits; the CLI groups it. The check depends on the local clone being up to date and on app tags (`web-2026.10.13`, `cli-v0.1.8`) existing; an app never tagged is compared from `--since` or the start of history.

## 17. Milestone membership is stored on the task and inherited by computing; the tracker only moves a milestone forward

**Decision:** a task joins a milestone (ST-96) through its own `tasks.milestone_id`, which must point at a milestone of the same project. A sub-task without one belongs to its nearest ancestor's milestone, worked out on read with a recursive query; the inherited value is never written to the sub-task. When a change completes an open milestone (every task Done, all their code shipped), the tracker moves it to the first `in_review` status of its workflow (Ready to close) as a per-organization integration bot, `@spider`, with activity source `system`. It never moves a milestone backwards, and closing it is left to a person.

**Why:**
- Computing inheritance means re-parenting a task, or changing a parent's milestone, moves the whole subtree with nothing to keep in step; storing copies would need every parent change, delete and milestone change to rewrite descendants (and would race with concurrent re-parents). Sub-tasks nest at most 20 levels, so the walk is short, and a sub-task can still have its own milestone, which wins.
- Same project only: a roadmap is per project (an org-wide one comes later, ST-98), and it keeps a scoped agent from putting tasks into milestones it can't see. Inheritance stays inside the project too: the walk up (and down) only passes through tasks of the milestone's project, so a sub-task under another project's task has no milestone unless it joins one of its own project. Otherwise a scoped agent finishing its own task could move a milestone it can't see, and a milestone's progress would count tasks some of its viewers can't see.
- "Has code" follows ST-93's shipping state (Done and not `noCode`), so a milestone of documentation tasks marked no code is ready as soon as they are Done. Canceled tasks are left out of the progress, so an abandoned task doesn't keep a milestone open.
- ST-85's PR automation acts as the GitHub bot because the change comes from git. Moving a milestone isn't git-driven, so it gets its own bot through the same helper (`ensureBot`), and `system` keeps it apart from people and agents in the activity log. It runs in the transaction of the change that completed the milestone, after locking the milestone row, so two tasks finishing at once can't both miss the other's change.
- Moving only forward, and only from Planned or Active, keeps the person in charge: adding a task to a milestone that is Ready to close or Done doesn't reopen it, and a person can move it back by hand without the tracker fighting them.

**Trade-off:** reading a task's milestone, and every milestone's progress, costs a recursive query (one per list, not per task). Deleting a parent leaves its sub-tasks' inherited milestone with it (they become top-level tasks with no milestone of their own). Old Done tasks with code that predate releases count as not shipped until a release ships them or they are marked no code, so imported phases show "0/N shipped" until then.
