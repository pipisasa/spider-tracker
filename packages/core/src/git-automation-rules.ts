import type { GitAutomationEvent, GitAutomationSettings, GitLinkVia, PullRequestState, StatusCategory } from "./contracts";
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
  if (stored === null || stored === undefined) return { ...DEFAULT_GIT_AUTOMATION };
  const parsed = gitAutomationSchema.partial().safeParse(stored);
  return parsed.success ? { ...DEFAULT_GIT_AUTOMATION, ...parsed.data } : { ...DEFAULT_GIT_AUTOMATION };
}

/** Links that move tasks; a mention in the body ("body") or a commit message ("message") doesn't. */
export const AUTOMATING_VIA: readonly GitLinkVia[] = ["closing", "branch", "title"];

/** The automation event of a pull_request action, given the PR as saved; null for actions that move nothing (edited, synchronize, …). */
export function pullRequestEvent(action: string, pr: { state: PullRequestState; draft: boolean }): GitAutomationEvent | null {
  if (pr.state === "merged") return action === "closed" ? "merged" : null;
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

const RANK: Record<StatusCategory, number> = { backlog: 0, todo: 1, in_progress: 2, in_review: 3, done: 4, canceled: 4 };
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
export function decideTransition({ event, current, settings, others }: TransitionInput): StatusCategory | null {
  if (!settings.enabled) return null;
  const target = settings[event];
  if (target === null || target === current) return null;
  if (CLOSED.includes(current)) return null;
  const open = others.filter((pr) => pr.state === "open");
  if (CLOSED.includes(target) && open.length > 0) return null;
  if (RANK[target] > RANK[current]) return target;
  if (event === "draft" && current === settings.opened && !open.some((pr) => !pr.draft)) return target;
  return null;
}
