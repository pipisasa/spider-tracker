import type {
  GitAutomationEvent,
  GitAutomationSettings,
  GitLinkVia,
  PullRequestState,
  StatusCategory,
} from "./contracts";
import { gitAutomationSchema } from "./schemas";

// The rules of status automation from pull request events (ST-85), with no database imports; the
// automation itself is in git-automation.ts. Its comment lists the rules.

/** Draft → In Progress, opened or ready → In Review, merged → Done, closed unmerged → no change. */
export const DEFAULT_GIT_AUTOMATION: GitAutomationSettings = {
  enabled: true,
  draft: "in_progress",
  opened: "in_review",
  merged: "done",
  closed: null,
};

/** A project's settings from its stored `git_automation` (null, or anything that doesn't parse, is the defaults). */
export function gitAutomationOf(stored: unknown): GitAutomationSettings {
  if (stored === null || stored === undefined)
    return { ...DEFAULT_GIT_AUTOMATION };
  const parsed = gitAutomationSchema.partial().safeParse(stored);
  return parsed.success
    ? { ...DEFAULT_GIT_AUTOMATION, ...parsed.data }
    : { ...DEFAULT_GIT_AUTOMATION };
}

/** Links that move tasks; a mention in the body ("body") or a commit message ("message") doesn't. */
export const AUTOMATING_VIA: readonly GitLinkVia[] = [
  "closing",
  "branch",
  "title",
];

/** GitHub's `author_association` values whose pull requests may move tasks. */
export const TRUSTED_AUTHOR_ASSOCIATIONS: readonly string[] = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
];

/** Who opened a pull request, as a webhook says (only what the trust check needs). */
export interface PullRequestSource {
  /** The base repo, "owner/name". */
  baseRepo: string;
  /** The head branch's repo, "owner/name"; null when GitHub no longer has it (a deleted fork). */
  headRepo: string | null;
  /** The PR author's `author_association` (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, …). */
  authorAssociation: string | null;
  /** The PR author's account type ("User", "Bot", …). */
  authorType: string | null;
  /** The PR author's login, e.g. "spider-tracker[bot]". */
  authorLogin: string | null;
  /** Our own GitHub App's slug (GITHUB_APP_SLUG, passed in by the API); null trusts no bot. */
  appSlug: string | null;
}

/** The login GitHub gives a GitHub App's bot user. */
export const appBotLogin = (slug: string) => `${slug}[bot]`;

/**
 * Whether a pull request from a webhook may move tasks: its head branch is in the base repo (not
 * a fork), and its author is an owner, member or collaborator of the repo, or our own App's bot
 * (`<slug>[bot]`, opening PRs for `spider pr`, ST-87; its association is often NONE). Other bots
 * (Dependabot, Renovate, …) are never trusted, whatever their association: their PR bodies quote
 * upstream release notes, whose "Fixes API-12" would otherwise close our API-12 on merge (ST-141).
 * Untrusted PRs still link to tasks, but never move them. Trust depends on the author only: a
 * maintainer merging an outside contributor's PR doesn't make it trusted, so the task is moved by
 * hand (a deliberate choice, see docs/git-integration.md).
 */
export function trustedPullRequest({
  baseRepo,
  headRepo,
  authorAssociation,
  authorType,
  authorLogin,
  appSlug,
}: PullRequestSource): boolean {
  if (headRepo === null || headRepo.toLowerCase() !== baseRepo.toLowerCase())
    return false;
  if (authorType === "Bot")
    return (
      appSlug !== null &&
      authorLogin !== null &&
      authorLogin.toLowerCase() === appBotLogin(appSlug).toLowerCase()
    );
  return (
    authorAssociation !== null &&
    TRUSTED_AUTHOR_ASSOCIATIONS.includes(authorAssociation)
  );
}

/**
 * The automation event of a pull_request action, given the PR as saved and the repo's default
 * branch; null for actions that move nothing (edited, synchronize, …). A merge counts only into
 * the default branch: one into another branch (a stacked PR, a release or feature branch) hasn't
 * shipped the work yet. Opened, ready and draft events count whatever the base: the work is in
 * review either way.
 */
export function pullRequestEvent(
  action: string,
  pr: { state: PullRequestState; draft: boolean; baseBranch: string },
  defaultBranch: string,
): GitAutomationEvent | null {
  if (pr.state === "merged")
    return action === "closed" && pr.baseBranch === defaultBranch
      ? "merged"
      : null;
  if (pr.state === "closed") return action === "closed" ? "closed" : null;
  switch (action) {
    case "opened":
    case "reopened":
      return pr.draft ? "draft" : "opened";
    case "ready_for_review":
      return "opened";
    case "converted_to_draft":
      return "draft";
    default:
      return null;
  }
}

const RANK: Record<StatusCategory, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
  canceled: 4,
};
const CLOSED: readonly StatusCategory[] = ["done", "canceled"];

export interface TransitionInput {
  event: GitAutomationEvent;
  /** The task's status category now. */
  current: StatusCategory;
  settings: GitAutomationSettings;
  /** The task's other pull requests linked by closing keyword, branch or title (not this one). */
  others: { state: PullRequestState; draft: boolean }[];
}

/** The status category a task moves to on a pull request event, or null to leave it (see the rules above). */
export function decideTransition({
  event,
  current,
  settings,
  others,
}: TransitionInput): StatusCategory | null {
  if (!settings.enabled) return null;
  const target = settings[event];
  if (target === null || target === current) return null;
  if (CLOSED.includes(current)) return null;
  const open = others.filter((pr) => pr.state === "open");
  if (CLOSED.includes(target) && open.length > 0) return null;
  if (RANK[target] > RANK[current]) return target;
  if (
    event === "draft" &&
    current === settings.opened &&
    !open.some((pr) => !pr.draft)
  )
    return target;
  return null;
}
