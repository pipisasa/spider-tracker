import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { ActorContext, Viewer } from "./access";
import type {
  GitBranchDto,
  GitCommitDto,
  GitLinkVia,
  PullRequestDto,
  PullRequestState,
  TaskGitDto,
} from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import { automatePullRequest } from "./git-automation";
import { trustedPullRequest } from "./git-automation-rules";
import { closingKeysIn, taskKeyFromBranch, taskKeysIn } from "./git";
import type { GithubEventHandler } from "./github-webhooks";
import { repoFullName } from "./remotes";
import { parseTaskKey } from "./schemas";
import { findTask } from "./tasks";

// Branches, commits and pull requests linked to tasks (ST-84), from GitHub's create, delete, push
// and pull_request events. A key links only when the task exists and its project is attached to
// the repo, which also drops look-alikes such as "UTF-8" and "SHA-256". Links are kept when a
// branch is deleted; a pull request's links follow its latest title, body and branch.
//
// A push's commits cover its whole before..after range: a merge of main into a task branch lists
// main's commits too, with `distinct: false` (already pushed elsewhere). The branch's key links
// only distinct commits; keys in a commit's message link it whatever branch it arrives on (ST-143).
//
// Links stay when a branch is force-pushed (the old commits keep theirs) and when a repo is
// detached from a project; reading a task's links shows only those of repos attached to its
// project, so attaching the repo again brings them back.
//
// Webhooks can arrive out of order: a pull_request event older (by the PR's `updated_at`) than the
// one stored changes nothing, and a merged PR stays merged.

const { gitLinks, projectRepos, projects, pullRequests, repos, tasks } = schema;

type RepoRow = typeof repos.$inferSelect;
type PullRequestRow = typeof pullRequests.$inferSelect;

/** Strongest first; a link found several ways keeps the strongest. */
const VIA_ORDER: readonly GitLinkVia[] = [
  "closing",
  "branch",
  "title",
  "body",
  "message",
];
const VIA_SQL = sql.raw(
  `array[${VIA_ORDER.map((v) => `'${v}'`).join(", ")}]::text[]`,
);

const stronger = (a: GitLinkVia, b: GitLinkVia | undefined): GitLinkVia =>
  b === undefined || VIA_ORDER.indexOf(a) <= VIA_ORDER.indexOf(b) ? a : b;

/** Keys a task can be found by in one place, at most this many (a PR body may list many). */
const MAX_KEYS = 50;
/** At most this many commits of a push are read. */
const MAX_PUSH_COMMITS = 2048;
const COMMIT_TITLE_MAX = 300;

function addMatch(
  matches: Map<string, GitLinkVia>,
  key: string,
  via: GitLinkVia,
) {
  if (matches.size >= MAX_KEYS && !matches.has(key)) return;
  matches.set(key, stronger(via, matches.get(key)));
}

/** The task keys a pull request names, each with the strongest way it does. */
export function pullRequestKeys(pr: {
  title: string;
  body: string | null;
  headBranch: string;
}): Map<string, GitLinkVia> {
  const matches = new Map<string, GitLinkVia>();
  const body = pr.body ?? "";
  for (const key of closingKeysIn(`${pr.title}\n${body}`))
    addMatch(matches, key, "closing");
  const branchKey = taskKeyFromBranch(pr.headBranch);
  if (branchKey) addMatch(matches, branchKey, "branch");
  for (const key of taskKeysIn(pr.title)) addMatch(matches, key, "title");
  for (const key of taskKeysIn(body)) addMatch(matches, key, "body");
  return matches;
}

/** The task keys a commit names in its message, plus its branch's key. */
export function commitKeys(
  message: string,
  branchKey: string | null,
): Map<string, GitLinkVia> {
  const matches = new Map<string, GitLinkVia>();
  for (const key of closingKeysIn(message)) addMatch(matches, key, "closing");
  if (branchKey) addMatch(matches, branchKey, "branch");
  for (const key of taskKeysIn(message)) addMatch(matches, key, "message");
  return matches;
}

// --- GitHub URLs, from the repo's current name ---------------------------------------------------

const repoUrl = (repo: { owner: string; name: string }) =>
  `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
const branchUrl = (repo: { owner: string; name: string }, branch: string) =>
  `${repoUrl(repo)}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
const commitUrl = (repo: { owner: string; name: string }, sha: string) =>
  `${repoUrl(repo)}/commit/${sha}`;
export const pullRequestUrl = (
  repo: { owner: string; name: string },
  number: number,
) => `${repoUrl(repo)}/pull/${number}`;

/** A saved pull request as the API shows it, with how it names the task. */
/** What a pull request DTO is built from: a saved row, or the same fields of one not saved. */
export type PullRequestDtoSource = Pick<
  PullRequestRow,
  | "number"
  | "title"
  | "state"
  | "draft"
  | "headBranch"
  | "baseBranch"
  | "authorLogin"
  | "mergedAt"
  | "closedAt"
  | "githubUpdatedAt"
>;

export function toPullRequestDto(
  repo: { owner: string; name: string },
  pr: PullRequestDtoSource,
  via: GitLinkVia,
): PullRequestDto {
  return {
    repo: repoFullName(repo),
    number: pr.number,
    title: pr.title,
    url: pullRequestUrl(repo, pr.number),
    state: pr.state,
    draft: pr.draft,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    author: pr.authorLogin,
    mergedAt: pr.mergedAt?.toISOString() ?? null,
    closedAt: pr.closedAt?.toISOString() ?? null,
    updatedAt: pr.githubUpdatedAt.toISOString(),
    via,
  };
}

// --- Finding repos and tasks ----------------------------------------------------------------------

/** A task a key resolved to. */
export interface LinkedTask {
  id: string;
  key: string;
  projectId: string;
  projectKey: string;
}

async function findRepoByName(
  tx: Tx,
  orgId: string,
  owner: string,
  name: string,
): Promise<RepoRow | null> {
  const [row] = await tx
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.orgId, orgId),
        sql`lower(${repos.owner}) = ${owner.toLowerCase()}`,
        sql`lower(${repos.name}) = ${name.toLowerCase()}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The tasks `keys` name, by key; only tasks (not deleted) of projects attached to `repo`. */
export async function tasksOfKeys(
  tx: Db | Tx,
  repo: RepoRow,
  keys: Iterable<string>,
): Promise<Map<string, LinkedTask>> {
  const numbersByProject = new Map<string, number[]>();
  for (const key of keys) {
    const parsed = parseTaskKey(key);
    if (!parsed) continue;
    numbersByProject.set(parsed.projectKey, [
      ...(numbersByProject.get(parsed.projectKey) ?? []),
      parsed.number,
    ]);
  }
  if (numbersByProject.size === 0) return new Map();
  const conditions: SQL[] = [];
  for (const [projectKey, numbers] of numbersByProject) {
    const condition = and(
      eq(projects.key, projectKey),
      inArray(tasks.number, numbers),
    );
    if (condition) conditions.push(condition);
  }
  const rows = await tx
    .select({
      id: tasks.id,
      number: tasks.number,
      projectId: tasks.projectId,
      projectKey: projects.key,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(
      projectRepos,
      and(
        eq(projectRepos.projectId, projects.id),
        eq(projectRepos.repoId, repo.id),
      ),
    )
    .where(
      and(
        eq(projects.orgId, repo.orgId),
        isNull(tasks.deletedAt),
        or(...conditions),
      ),
    );
  return new Map(
    rows.map((r) => [
      `${r.projectKey}-${r.number}`,
      {
        id: r.id,
        key: `${r.projectKey}-${r.number}`,
        projectId: r.projectId,
        projectKey: r.projectKey,
      },
    ]),
  );
}

/** The keys of tasks by id (for events about links that were removed or changed). */
async function tasksByIds(tx: Tx, ids: string[]): Promise<LinkedTask[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: tasks.id,
      number: tasks.number,
      projectId: tasks.projectId,
      projectKey: projects.key,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(tasks.id, [...new Set(ids)]));
  return rows.map((r) => ({
    id: r.id,
    key: `${r.projectKey}-${r.number}`,
    projectId: r.projectId,
    projectKey: r.projectKey,
  }));
}

async function announce(tx: Tx, orgId: string, linked: Iterable<LinkedTask>) {
  const seen = new Set<string>();
  for (const task of linked) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    await publish(tx, {
      type: "task.git",
      orgId,
      projectKey: task.projectKey,
      taskKey: task.key,
    });
  }
}

// --- Branches and commits ---------------------------------------------------------------------------

/** Links a branch to a task; a deleted one that is created again is live again. True when changed. */
async function linkBranch(
  tx: Tx,
  repo: RepoRow,
  task: LinkedTask,
  branch: string,
): Promise<boolean> {
  const now = new Date();
  const [row] = await tx
    .insert(gitLinks)
    .values({
      orgId: repo.orgId,
      taskId: task.id,
      repoId: repo.id,
      kind: "branch",
      ref: branch,
      via: "branch",
      occurredAt: now,
    })
    .onConflictDoUpdate({
      target: [gitLinks.taskId, gitLinks.repoId, gitLinks.kind, gitLinks.ref],
      set: { deletedAt: null, updatedAt: now },
      setWhere: sql`${gitLinks.deletedAt} is not null`,
    })
    .returning({ id: gitLinks.id });
  return row !== undefined;
}

/** Marks a branch's links deleted (they stay); the tasks whose link changed. */
async function markBranchDeleted(
  tx: Tx,
  repo: RepoRow,
  branch: string,
): Promise<LinkedTask[]> {
  const rows = await tx
    .update(gitLinks)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(gitLinks.repoId, repo.id),
        eq(gitLinks.kind, "branch"),
        eq(gitLinks.ref, branch),
        isNull(gitLinks.deletedAt),
      ),
    )
    .returning({ taskId: gitLinks.taskId });
  return tasksByIds(
    tx,
    rows.map((r) => r.taskId),
  );
}

interface CommitData {
  sha: string;
  message: string;
  author: string | null;
  committedAt: Date | null;
  /** False when the commit was already pushed elsewhere (main's commits in a merge of main into the branch). */
  distinct: boolean;
}

/**
 * Links commits to the tasks they name (and, for commits new to the repo, to the branch's task);
 * the tasks with new or stronger links.
 */
async function linkCommits(
  tx: Tx,
  repo: RepoRow,
  commits: CommitData[],
  branchKey: string | null,
): Promise<LinkedTask[]> {
  const perCommit = commits.map((commit) => ({
    commit,
    keys: commitKeys(commit.message, commit.distinct ? branchKey : null),
  }));
  const found = await tasksOfKeys(
    tx,
    repo,
    new Set(perCommit.flatMap((c) => [...c.keys.keys()])),
  );
  const values = perCommit.flatMap(({ commit, keys }) =>
    [...keys].flatMap(([key, via]) => {
      const task = found.get(key);
      if (!task) return [];
      return [
        {
          orgId: repo.orgId,
          taskId: task.id,
          repoId: repo.id,
          kind: "commit" as const,
          ref: commit.sha,
          via,
          title: (commit.message.split("\n", 1)[0] ?? "")
            .trim()
            .slice(0, COMMIT_TITLE_MAX),
          author: commit.author,
          occurredAt: commit.committedAt,
        },
      ];
    }),
  );
  const changed: string[] = [];
  for (let i = 0; i < values.length; i += 500) {
    const rows = await tx
      .insert(gitLinks)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [gitLinks.taskId, gitLinks.repoId, gitLinks.kind, gitLinks.ref],
        set: { via: sql`excluded.via`, updatedAt: new Date() },
        // Only a stronger match changes an existing link ("fixes ST-12" after a plain mention).
        setWhere: sql`array_position(${VIA_SQL}, excluded.via) < array_position(${VIA_SQL}, ${gitLinks.via})`,
      })
      .returning({ taskId: gitLinks.taskId });
    changed.push(...rows.map((r) => r.taskId));
  }
  const byId = new Map([...found.values()].map((t) => [t.id, t]));
  return changed.map((id) => byId.get(id)).filter((t) => t !== undefined);
}

// --- Pull requests -----------------------------------------------------------------------------------

/** A pull request event, after it was saved: what status automation (ST-85) gets. */
export interface PullRequestChange {
  /** The event's action: opened, edited, closed, reopened, ready_for_review, converted_to_draft, … */
  action: string;
  pullRequest: PullRequestRow;
  /** As stored before this event; null when first seen. */
  previous: PullRequestRow | null;
  /** The tasks it links to now, with how. */
  tasks: { task: LinkedTask; via: GitLinkVia }[];
  origin: PullRequestOrigin;
}

/** Where a pull request event comes from, for status automation (ST-85). */
export interface PullRequestOrigin {
  /** The repo's default branch: only a merge into it counts as merged. */
  defaultBranch: string;
  /** False for a PR from a fork or from an author who isn't trusted (trustedPullRequest): it links but moves nothing. */
  trusted: boolean;
  /** The GitHub login whose action sent the event (who merged, for a merge), kept in the activity. */
  sender: string | null;
  /**
   * Only this task (by id) may move: a PR Spider Tracker opens for a task (ST-87, ST-144) moves
   * that task alone right away, whatever else its branch, title or body name.
   */
  automateOnly?: string;
}

/**
 * Status automation from pull request events (ST-85, automatePullRequest in git-automation.ts): it
 * runs in the delivery's transaction after the PR and its links are saved (never for stale events)
 * and says whether it changed something.
 */
export type PullRequestAutomation = (
  tx: Tx,
  ctx: ActorContext,
  change: PullRequestChange,
) => Promise<boolean>;

const STATE_RANK: Record<PullRequestState, number> = {
  open: 0,
  closed: 1,
  merged: 2,
};

/** A pull request as GitHub describes it (from a webhook, or the API's answer when one is opened). */
export interface PullRequestData {
  number: number;
  title: string;
  body: string | null;
  state: PullRequestState;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  author: string | null;
  mergedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
}

/**
 * The state to keep when an event arrives: null when the event is older than the stored one
 * (stale). A merged PR stays merged; with the same `updated_at`, the state never goes back
 * (closed stays closed until a later reopen).
 */
export function nextPullRequestState(
  stored: { state: PullRequestState; githubUpdatedAt: Date } | null,
  incoming: { state: PullRequestState; updatedAt: Date },
): PullRequestState | null {
  if (!stored) return incoming.state;
  const age = incoming.updatedAt.getTime() - stored.githubUpdatedAt.getTime();
  if (age < 0) return null;
  if (stored.state === "merged") return "merged";
  if (age === 0 && STATE_RANK[stored.state] > STATE_RANK[incoming.state])
    return stored.state;
  return incoming.state;
}

/**
 * Saves a pull request event and links it to the tasks it names; false when stale or nothing to
 * link. `ctx` is the @github bot: status automation runs as it, given `origin`. Also used when
 * Spider Tracker opens the pull request itself (ST-87), so the link is there before GitHub's
 * webhook arrives.
 */
export async function savePullRequest(
  tx: Tx,
  ctx: ActorContext,
  repo: RepoRow,
  action: string,
  data: PullRequestData,
  origin: PullRequestOrigin,
): Promise<boolean> {
  // One PR event per repo at a time, so two first events of a PR can't both insert it. (No key
  // update: links and PRs referencing the repo can still be written meanwhile.)
  await tx
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.id, repo.id))
    .for("no key update");
  const [previous] = await tx
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, repo.id),
        eq(pullRequests.number, data.number),
      ),
    )
    .for("update")
    .limit(1);
  const state = nextPullRequestState(previous ?? null, data);
  if (state === null) return false;

  const matches = pullRequestKeys(data);
  const found = await tasksOfKeys(tx, repo, matches.keys());
  // A PR that names no task here isn't kept.
  if (!previous && found.size === 0) return false;

  const values = {
    title: data.title,
    state,
    draft: data.draft,
    headBranch: data.headBranch,
    baseBranch: data.baseBranch,
    authorLogin: data.author,
    mergedAt: state === "merged" ? (previous?.mergedAt ?? data.mergedAt) : null,
    closedAt:
      state === "open" ? null : (data.closedAt ?? previous?.closedAt ?? null),
    githubUpdatedAt: data.updatedAt,
    updatedAt: new Date(),
  };
  const [pullRequest] = previous
    ? await tx
        .update(pullRequests)
        .set(values)
        .where(eq(pullRequests.id, previous.id))
        .returning()
    : await tx
        .insert(pullRequests)
        .values({
          ...values,
          orgId: repo.orgId,
          repoId: repo.id,
          number: data.number,
        })
        .returning();
  if (!pullRequest) throw new Error("Failed to save the pull request");

  // Its links follow the latest title, body and branch.
  const linked = [...found.values()].map((task) => ({
    task,
    via: matches.get(task.key) ?? "body",
  }));
  const before = await tx
    .select({ id: gitLinks.id, taskId: gitLinks.taskId, via: gitLinks.via })
    .from(gitLinks)
    .where(eq(gitLinks.pullRequestId, pullRequest.id));
  const keep = new Set(linked.map((l) => l.task.id));
  const removed = before.filter((l) => !keep.has(l.taskId));
  if (removed.length) {
    await tx.delete(gitLinks).where(
      inArray(
        gitLinks.id,
        removed.map((l) => l.id),
      ),
    );
  }
  for (const { task, via } of linked) {
    await tx
      .insert(gitLinks)
      .values({
        orgId: repo.orgId,
        taskId: task.id,
        repoId: repo.id,
        kind: "pull_request",
        ref: String(data.number),
        pullRequestId: pullRequest.id,
        via,
      })
      .onConflictDoUpdate({
        target: [gitLinks.taskId, gitLinks.repoId, gitLinks.kind, gitLinks.ref],
        set: { via, pullRequestId: pullRequest.id, updatedAt: new Date() },
      });
  }

  await announce(tx, ctx.orgId, [
    ...linked.map((l) => l.task),
    ...(await tasksByIds(
      tx,
      removed.map((l) => l.taskId),
    )),
  ]);
  const automated =
    origin.automateOnly === undefined
      ? linked
      : linked.filter((l) => l.task.id === origin.automateOnly);
  await automatePullRequest(tx, ctx, {
    action,
    pullRequest,
    previous: previous ?? null,
    tasks: automated,
    origin,
  });
  return true;
}

// --- Webhook payloads: only the fields used -----------------------------------------------------------

function parsePayload<T extends z.ZodType>(
  schemaOf: T,
  event: string,
  payload: unknown,
): z.infer<T> {
  const parsed = schemaOf.safeParse(payload);
  if (!parsed.success)
    throw new DomainError(
      "validation",
      `Unexpected ${event} payload: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  return parsed.data;
}

const repositoryRef = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});
const userRef = z.object({ login: z.string(), type: z.string().optional() });
const timestamp = z.iso.datetime({ offset: true });

const refPayload = z.object({
  ref: z.string().min(1),
  ref_type: z.string(),
  repository: repositoryRef,
});

const pushPayload = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  commits: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{40}$/i),
        message: z.string(),
        timestamp: timestamp.nullable().optional(),
        author: z
          .object({
            name: z.string().optional(),
            username: z.string().optional(),
          })
          .nullable()
          .optional(),
        distinct: z.boolean().optional(),
      }),
    )
    .nullable()
    .optional(),
  repository: repositoryRef,
});

const pullRequestPayload = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().optional(),
    merged: z.boolean().nullable().optional(),
    merged_at: timestamp.nullable().optional(),
    closed_at: timestamp.nullable().optional(),
    updated_at: timestamp,
    head: z.object({
      ref: z.string(),
      repo: z.object({ full_name: z.string() }).nullable().optional(),
    }),
    base: z.object({ ref: z.string() }),
    user: userRef.nullable().optional(),
    author_association: z.string().optional(),
  }),
  repository: repositoryRef.extend({
    default_branch: z.string().min(1).optional(),
  }),
  sender: userRef.nullable().optional(),
});

const HEADS = "refs/heads/";

/** create: a branch whose name has a task key links to the task. Tags are ignored. */
export const handleCreate: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(refPayload, "create", e.payload);
  if (data.ref_type !== "branch") return false;
  const key = taskKeyFromBranch(data.ref);
  const repo = key
    ? await findRepoByName(
        tx,
        e.ctx.orgId,
        data.repository.owner.login,
        data.repository.name,
      )
    : null;
  if (!key || !repo) return false;
  const task = (await tasksOfKeys(tx, repo, [key])).get(key);
  if (!task || !(await linkBranch(tx, repo, task, data.ref))) return false;
  await announce(tx, e.ctx.orgId, [task]);
  return true;
};

/** delete: a deleted branch's links are marked deleted. */
export const handleDelete: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(refPayload, "delete", e.payload);
  if (data.ref_type !== "branch") return false;
  const repo = await findRepoByName(
    tx,
    e.ctx.orgId,
    data.repository.owner.login,
    data.repository.name,
  );
  if (!repo) return false;
  const changed = await markBranchDeleted(tx, repo, data.ref);
  await announce(tx, e.ctx.orgId, changed);
  return changed.length > 0;
};

/** push: links the branch (by its name) and its commits (by their messages, and the branch's key). */
export const handlePush: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(pushPayload, "push", e.payload);
  if (!data.ref.startsWith(HEADS)) return false;
  const branch = data.ref.slice(HEADS.length);
  const repo = await findRepoByName(
    tx,
    e.ctx.orgId,
    data.repository.owner.login,
    data.repository.name,
  );
  if (!repo) return false;
  if (data.deleted) {
    const changed = await markBranchDeleted(tx, repo, branch);
    await announce(tx, e.ctx.orgId, changed);
    return changed.length > 0;
  }

  const changed: LinkedTask[] = [];
  const branchKey = taskKeyFromBranch(branch);
  const branchTask = branchKey
    ? (await tasksOfKeys(tx, repo, [branchKey])).get(branchKey)
    : undefined;
  if (branchTask && (await linkBranch(tx, repo, branchTask, branch)))
    changed.push(branchTask);
  const commits = (data.commits ?? []).slice(0, MAX_PUSH_COMMITS).map((c) => ({
    sha: c.id.toLowerCase(),
    message: c.message,
    author: c.author?.username ?? c.author?.name ?? null,
    committedAt: c.timestamp ? new Date(c.timestamp) : null,
    distinct: c.distinct !== false,
  }));
  changed.push(
    ...(await linkCommits(tx, repo, commits, branchTask ? branchKey : null)),
  );
  await announce(tx, e.ctx.orgId, changed);
  return changed.length > 0;
};

/**
 * pull_request: saves the PR (unless the event is stale) and links it to the tasks named by its
 * branch, title (closing keywords too) and body. Status automation counts a merge only into the
 * repo's default branch, and skips PRs from forks and untrusted authors (trustedPullRequest).
 */
export const handlePullRequest: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(pullRequestPayload, "pull_request", e.payload);
  const pr = data.pull_request;
  const repo = await findRepoByName(
    tx,
    e.ctx.orgId,
    data.repository.owner.login,
    data.repository.name,
  );
  if (!repo) return false;
  const merged =
    pr.merged === true || (pr.state === "closed" && pr.merged_at != null);
  const origin: PullRequestOrigin = {
    defaultBranch: data.repository.default_branch ?? repo.defaultBranch,
    trusted: trustedPullRequest({
      baseRepo: `${data.repository.owner.login}/${data.repository.name}`,
      headRepo: pr.head.repo?.full_name ?? null,
      authorAssociation: pr.author_association ?? null,
      authorType: pr.user?.type ?? null,
      authorLogin: pr.user?.login ?? null,
      appSlug: e.appSlug,
    }),
    sender: data.sender?.login ?? null,
  };
  const saved: PullRequestData = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state: merged ? "merged" : pr.state,
    draft: pr.draft ?? false,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    author: pr.user?.login ?? null,
    mergedAt: merged && pr.merged_at ? new Date(pr.merged_at) : null,
    closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
    updatedAt: new Date(pr.updated_at),
  };
  return savePullRequest(tx, e.ctx, repo, data.action, saved, origin);
};

// --- Reading ------------------------------------------------------------------------------------------

/** At most this many commits are listed, newest first. */
const COMMITS_LISTED = 100;

/**
 * What is linked to a task in git: pull requests (recently updated first), branches and commits
 * (newest first), only in repos attached to the task's project (a detached repo's links are kept,
 * not shown).
 */
export async function getTaskGit(
  db: Db,
  viewer: Viewer,
  taskKey: string,
): Promise<TaskGitDto> {
  const { task, projectKey } = await findTask(db, viewer, taskKey);
  const repo = { owner: repos.owner, name: repos.name };
  const attached = and(
    eq(projectRepos.repoId, gitLinks.repoId),
    eq(projectRepos.projectId, task.projectId),
  );

  const prRows = await db
    .select({ repo, pr: pullRequests, via: gitLinks.via })
    .from(gitLinks)
    .innerJoin(pullRequests, eq(pullRequests.id, gitLinks.pullRequestId))
    .innerJoin(repos, eq(repos.id, gitLinks.repoId))
    .innerJoin(projectRepos, attached)
    .where(and(eq(gitLinks.taskId, task.id), eq(gitLinks.kind, "pull_request")))
    .orderBy(desc(pullRequests.githubUpdatedAt), desc(pullRequests.number));
  const branchRows = await db
    .select({ repo, link: gitLinks })
    .from(gitLinks)
    .innerJoin(repos, eq(repos.id, gitLinks.repoId))
    .innerJoin(projectRepos, attached)
    .where(and(eq(gitLinks.taskId, task.id), eq(gitLinks.kind, "branch")))
    .orderBy(desc(gitLinks.createdAt));
  const commitRows = await db
    .select({ repo, link: gitLinks })
    .from(gitLinks)
    .innerJoin(repos, eq(repos.id, gitLinks.repoId))
    .innerJoin(projectRepos, attached)
    .where(and(eq(gitLinks.taskId, task.id), eq(gitLinks.kind, "commit")))
    .orderBy(
      sql`${gitLinks.occurredAt} desc nulls last`,
      desc(gitLinks.createdAt),
    )
    .limit(COMMITS_LISTED);

  const pullRequestDtos: PullRequestDto[] = prRows.map(({ repo, pr, via }) =>
    toPullRequestDto(repo, pr, via),
  );
  const branches: GitBranchDto[] = branchRows.map(({ repo, link }) => ({
    repo: repoFullName(repo),
    name: link.ref,
    url: branchUrl(repo, link.ref),
    deleted: link.deletedAt !== null,
    linkedAt: (link.occurredAt ?? link.createdAt).toISOString(),
  }));
  const commits: GitCommitDto[] = commitRows.map(({ repo, link }) => ({
    repo: repoFullName(repo),
    sha: link.ref,
    message: link.title ?? "",
    url: commitUrl(repo, link.ref),
    author: link.author,
    committedAt: link.occurredAt?.toISOString() ?? null,
    via: link.via,
  }));
  return {
    taskKey: `${projectKey}-${task.number}`,
    pullRequests: pullRequestDtos,
    branches,
    commits,
  };
}
