import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq } from "drizzle-orm";
import { assertCanWrite, inScope, projectScope, type ActorContext } from "./access";
import type { OpenedPullRequestDto } from "./contracts";
import { DomainError } from "./errors";
import { branchNameFor, closingKeysIn } from "./git";
import { pullRequestKeys, pullRequestUrl, savePullRequest, tasksOfKeys, toPullRequestDto, type PullRequestData } from "./git-links";
import { githubBotContext } from "./github";
import { parseRepoRemote, repoFullName } from "./remotes";
import { openPullRequestInput } from "./schemas";
import { findTask } from "./tasks";
import { parseInput } from "./validate";

// Opening a task's pull request from Spider Tracker (ST-87): `spider pr`, the API and the MCP tool
// open it on GitHub as the App (its installation token), then link it to the task right away with
// the webhook code (git-links.ts), so the task shows it, and status automation (ST-85) moves the
// task, before GitHub's pull_request event arrives. The event then changes nothing more.
//
// The repo is one of those attached to the task's project: the one named (the CLI passes its
// origin remote), or the only one. The title and body come from the task; the body always closes
// the task ("Closes ST-12"), so merging the PR moves it to Done.
//
// Every task the head, title and body name in a project attached to the repo is linked, and GitHub's
// own events may move it later; so each must be in the caller's project scope (ST-144), or the
// request is refused before GitHub is asked. The synthetic event moves only the task asked for.
//
// Core never calls GitHub: the API passes `create`, its GitHub port's createPullRequest.

const { githubInstallations, projectRepos, pullRequests, repos } = schema;

type RepoRow = typeof repos.$inferSelect;

/** What GitHub is asked to open. */
export interface GithubPullRequestRequest {
  installationId: number;
  owner: string;
  name: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

/** A pull request as GitHub's REST API answers. */
export interface GithubPullRequestData {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  author: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

/** `created` false: GitHub already had an open pull request for the branch, returned instead. */
export interface CreatePullRequestResult {
  created: boolean;
  pullRequest: GithubPullRequestData;
}

/** Opens a pull request on GitHub (the API's GitHub port). */
export type CreatePullRequest = (request: GithubPullRequestRequest) => Promise<CreatePullRequestResult>;

/** The default title: the task's title and key, "Fix the login (ST-12)". */
export function pullRequestTitleFor(taskKey: string, title: string): string {
  const suffix = ` (${taskKey})`;
  const max = 256 - suffix.length;
  const trimmed = title.trim();
  return `${trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed}${suffix}`;
}

/**
 * The body: the given one (or a link to the task), ending with "Closes ST-12" unless it already
 * closes the task with a keyword, so merging the PR finishes the task.
 */
export function pullRequestBodyFor(taskKey: string, { body, taskUrl }: { body?: string; taskUrl?: string }): string {
  const text = (body ?? (taskUrl ? `Task: [${taskKey}](${taskUrl})` : "")).trim();
  if (closingKeysIn(text).includes(taskKey)) return text;
  return text ? `${text}\n\nCloses ${taskKey}` : `Closes ${taskKey}`;
}

/** As `savePullRequest` takes it. */
function pullRequestData(pr: GithubPullRequestData): PullRequestData {
  const merged = pr.merged || (pr.state === "closed" && pr.mergedAt !== null);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: merged ? "merged" : pr.state,
    draft: pr.draft,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    author: pr.author,
    mergedAt: merged && pr.mergedAt ? new Date(pr.mergedAt) : null,
    closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
    updatedAt: new Date(pr.updatedAt),
  };
}

/** The repo to open the PR in: the one named among the project's repos, or its only one. */
async function pickRepo(db: Db, projectId: string, projectKey: string, ref: string | undefined): Promise<RepoRow> {
  const attached = await db
    .select({ repo: repos })
    .from(projectRepos)
    .innerJoin(repos, eq(repos.id, projectRepos.repoId))
    .where(eq(projectRepos.projectId, projectId))
    .orderBy(asc(repos.owner), asc(repos.name));
  const names = attached.map((r) => repoFullName(r.repo)).join(", ");
  if (attached.length === 0) {
    throw new DomainError("validation", `Project ${projectKey} has no repo: attach one first (spider repo attach ${projectKey})`);
  }
  if (ref === undefined) {
    if (attached.length > 1) throw new DomainError("validation", `Project ${projectKey} has several repos (${names}): name one with repo`);
    return attached[0]!.repo;
  }
  const remote = parseRepoRemote(ref);
  if (!remote) throw new DomainError("validation", `Not a GitHub repo: "${ref}". Use owner/name or a GitHub URL`);
  const match = attached.find(
    (r) => r.repo.owner.toLowerCase() === remote.owner.toLowerCase() && r.repo.name.toLowerCase() === remote.name.toLowerCase(),
  );
  if (!match) throw new DomainError("validation", `Repo ${repoFullName(remote)} isn't attached to project ${projectKey} (its repos: ${names})`);
  return match.repo;
}

/** The repo's installation, when the App can act in it. */
async function installationOf(db: Db, repo: RepoRow): Promise<number> {
  const notConnected = () =>
    new DomainError("validation", `The GitHub App has no access to ${repoFullName(repo)}: connect it in Settings → GitHub`);
  if (repo.githubInstallationId === null) throw notConnected();
  const [installation] = await db
    .select({ id: githubInstallations.id, suspendedAt: githubInstallations.suspendedAt })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.id, repo.githubInstallationId), eq(githubInstallations.orgId, repo.orgId)))
    .limit(1);
  if (!installation) throw notConnected();
  if (installation.suspendedAt) throw new DomainError("validation", `The GitHub App is suspended for ${repoFullName(repo)}: unsuspend it on GitHub`);
  return installation.id;
}

/**
 * Refuses (as not found, naming no key) a pull request whose head, title or body names a task in
 * a project attached to the repo that the caller can't see.
 */
async function assertKeysInScope(db: Db, ctx: ActorContext, repo: RepoRow, pr: { title: string; body: string; headBranch: string }) {
  const scope = await projectScope(db, ctx);
  if (!scope) return;
  const named = await tasksOfKeys(db, repo, pullRequestKeys(pr).keys());
  if ([...named.values()].some((t) => !inScope(scope, t.projectId))) {
    throw new DomainError("not_found", "The branch, title or body names a task that wasn't found in your projects");
  }
}

/**
 * Opens a pull request for a task on GitHub and links it to the task (`POST /tasks/:key/pull-request`).
 * A pull request already open for the branch is a conflict whose `url` is that PR (it is linked too
 * when it names the task). Guests can't; scoped agents only in their projects.
 */
export async function openTaskPullRequest(
  db: Db,
  ctx: ActorContext,
  taskKey: string,
  input: unknown,
  { create, taskUrl }: { create: CreatePullRequest; taskUrl?: (key: string) => string },
): Promise<OpenedPullRequestDto> {
  assertCanWrite(ctx);
  const data = parseInput(openPullRequestInput, input);
  const { task, projectKey } = await findTask(db, ctx, taskKey);
  const key = `${projectKey}-${task.number}`;
  const repo = await pickRepo(db, task.projectId, projectKey, data.repo);
  const installationId = await installationOf(db, repo);
  const head = data.head ?? branchNameFor(key, task.title);
  const base = data.base ?? repo.defaultBranch;
  if (head === base) throw new DomainError("validation", `The branch ${head} is the base branch: push the task's work to its own branch`);

  const exists = (number: number) =>
    new DomainError("conflict", `A pull request is already open for ${head}: ${pullRequestUrl(repo, number)}`, {
      url: pullRequestUrl(repo, number),
    });
  const [known] = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.headBranch, head), eq(pullRequests.state, "open")))
    .limit(1);
  if (known) throw exists(known.number);

  const title = data.title ?? pullRequestTitleFor(key, task.title);
  const body = pullRequestBodyFor(key, { body: data.body, taskUrl: taskUrl?.(key) });
  await assertKeysInScope(db, ctx, repo, { title, body, headBranch: head });

  const { created, pullRequest } = await create({
    installationId,
    owner: repo.owner,
    name: repo.name,
    head,
    base,
    title,
    body,
    draft: data.draft ?? false,
  });

  // As if GitHub's event had arrived: "opened" moves the task (as the @github bot); one that was
  // already open is only linked ("edited" moves nothing). It is trusted: the head is a branch of
  // this repo (a branch name, never "fork:branch") and the actor may write to the task; GitHub's
  // later events for it come from the App's bot, also trusted (trustedPullRequest). Only the
  // task asked for moves now.
  const saved = pullRequestData(pullRequest);
  const origin = { defaultBranch: repo.defaultBranch, trusted: true, sender: pullRequest.author, automateOnly: task.id };
  await db.transaction(async (tx) => savePullRequest(tx, await githubBotContext(tx, ctx.orgId), repo, created ? "opened" : "edited", saved, origin));
  if (!created) throw exists(pullRequest.number);

  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, pullRequest.number)))
    .limit(1);
  const via = pullRequestKeys(saved).get(key) ?? "body";
  if (row) return { taskKey: key, pullRequest: toPullRequestDto(repo, row, via) };
  // GitHub opened it but it wasn't kept (a newer event already stored, or it names no task here):
  // still answer with the pull request GitHub returned, never a 500.
  return {
    taskKey: key,
    pullRequest: {
      repo: repoFullName(repo),
      number: saved.number,
      title: saved.title,
      url: pullRequestUrl(repo, saved.number),
      state: saved.state,
      draft: saved.draft,
      headBranch: saved.headBranch,
      baseBranch: saved.baseBranch,
      author: saved.author,
      mergedAt: saved.mergedAt?.toISOString() ?? null,
      closedAt: saved.closedAt?.toISOString() ?? null,
      updatedAt: saved.updatedAt.toISOString(),
      via,
    },
  };
}
