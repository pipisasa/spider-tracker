import type { Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { StatusCategory } from "./contracts";
import { AUTOMATING_VIA, decideTransition, gitAutomationOf, pullRequestEvent } from "./git-automation-rules";
import type { PullRequestAutomation } from "./git-links";
import { applyTaskUpdate } from "./tasks";

// Status automation from pull request events (ST-85). When a pull request linked to a task is
// opened, marked ready, converted to a draft, merged or closed, the task moves to the status the
// project's settings name for that event, as the @github bot (source "git"):
//
// - Only ordinary tasks (kind "task") move; releases and milestones never do.
// - Only links by closing keyword, branch name or title count: a mention in the PR body links the
//   PR to the task but doesn't move it.
// - Forward only: a task never moves back in the workflow, and a finished or canceled task stays.
//   The one exception is a PR converted to (or opened as) a draft, which moves a task from the
//   `opened` status (In Review) back to the `draft` status (In Progress), unless another linked PR
//   is still open and ready.
// - A closing move (merged → Done) waits until no other linked PR is open.
// - The target is the first status of the setting's category in the task's own project and kind.

const { gitLinks, projects, pullRequests, statuses, tasks } = schema;

/**
 * Moves the tasks a saved pull request event links to (by closing keyword, branch or title), in
 * the delivery's transaction; `ctx` is the @github bot. Says whether a task changed.
 */
export const automatePullRequest: PullRequestAutomation = async (tx, ctx, { action, pullRequest, tasks: linked }) => {
  const event = pullRequestEvent(action, pullRequest);
  if (!event) return false;
  const ids = [...new Set(linked.filter((l) => AUTOMATING_VIA.includes(l.via)).map((l) => l.task.id))];
  if (ids.length === 0) return false;

  const rows = await tx
    .select({ task: tasks, projectKey: projects.key, gitAutomation: projects.gitAutomation, category: statuses.category })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(inArray(tasks.id, ids), eq(tasks.kind, "task"), isNull(tasks.deletedAt)))
    .for("update", { of: tasks });
  if (rows.length === 0) return false;

  const others = await tx
    .select({ taskId: gitLinks.taskId, state: pullRequests.state, draft: pullRequests.draft })
    .from(gitLinks)
    .innerJoin(pullRequests, eq(pullRequests.id, gitLinks.pullRequestId))
    .where(
      and(
        inArray(
          gitLinks.taskId,
          rows.map((r) => r.task.id),
        ),
        eq(gitLinks.kind, "pull_request"),
        inArray(gitLinks.via, [...AUTOMATING_VIA]),
        ne(pullRequests.id, pullRequest.id),
      ),
    );

  let changed = false;
  for (const row of rows) {
    const target = decideTransition({
      event,
      current: row.category,
      settings: gitAutomationOf(row.gitAutomation),
      others: others.filter((o) => o.taskId === row.task.id),
    });
    if (!target) continue;
    const status = await firstStatus(tx, row.task.projectId, target);
    if (!status) continue;
    const outcome = await applyTaskUpdate(tx, ctx, { task: row.task, projectKey: row.projectKey }, { statusId: status.id });
    changed ||= outcome.changed;
  }
  return changed;
};

/** The first status of a category in a project's task workflow, in board order. */
async function firstStatus(tx: Tx, projectId: string, category: StatusCategory): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.kind, "task"), eq(statuses.category, category)))
    .orderBy(asc(statuses.position))
    .limit(1);
  return row;
}
