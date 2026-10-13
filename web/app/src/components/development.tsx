import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { taskGitQuery } from "@/lib/work";
import type { PullRequestDto, TaskGitDto } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { useState } from "react";

// The task's pull requests, branches and commits from GitHub (ST-84).

const COMMITS_SHOWN = 5;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The label and icon of a pull request's state; an open draft is "Draft". */
export function pullRequestStatus(pr: Pick<PullRequestDto, "state" | "draft">) {
  if (pr.state === "merged")
    return {
      label: "Merged",
      Icon: GitMergeIcon,
      className: "text-violet-600 dark:text-violet-400",
    };
  if (pr.state === "closed")
    return {
      label: "Closed",
      Icon: GitPullRequestClosedIcon,
      className: "text-destructive",
    };
  if (pr.draft)
    return {
      label: "Draft",
      Icon: GitPullRequestDraftIcon,
      className: "text-muted-foreground",
    };
  return {
    label: "Open",
    Icon: GitPullRequestIcon,
    className: "text-emerald-600 dark:text-emerald-400",
  };
}

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

/** What the panel shows for a task's git links; a hint when there are none. */
export function DevelopmentLinks({ git }: { git: TaskGitDto }) {
  const [allCommits, setAllCommits] = useState(false);
  const empty =
    git.pullRequests.length + git.branches.length + git.commits.length === 0;
  if (empty) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing linked yet. Branches named after {git.taskKey}, and pull
        requests or commits that mention it, show up here once the repo is
        attached to the project and the GitHub App is installed.
      </p>
    );
  }
  const commits = allCommits
    ? git.commits
    : git.commits.slice(0, COMMITS_SHOWN);

  return (
    <ul className="divide-y rounded-lg border">
      {git.pullRequests.map((pr) => {
        const status = pullRequestStatus(pr);
        return (
          <li
            key={`pr-${pr.repo}-${pr.number}`}
            className="flex items-center gap-3 px-3 py-1.5 text-sm"
          >
            <status.Icon
              className={`size-4 shrink-0 ${status.className}`}
              aria-hidden
            />
            <a
              href={pr.url}
              {...external}
              className="flex min-w-0 flex-1 gap-2 hover:underline"
            >
              <span className="shrink-0 text-muted-foreground">
                #{pr.number}
              </span>
              <span className="truncate">{pr.title}</span>
            </a>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              {pr.repo}
            </span>
            <Badge variant="outline">{status.label}</Badge>
          </li>
        );
      })}
      {git.branches.map((b) => (
        <li
          key={`branch-${b.repo}-${b.name}`}
          className="flex items-center gap-3 px-3 py-1.5 text-sm"
        >
          <GitBranchIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <a
            href={b.url}
            {...external}
            className={`min-w-0 flex-1 truncate font-mono text-xs hover:underline ${b.deleted ? "line-through" : ""}`}
          >
            {b.name}
          </a>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {b.repo}
          </span>
          {b.deleted && <Badge variant="outline">Deleted</Badge>}
        </li>
      ))}
      {commits.map((c) => (
        <li
          key={`commit-${c.repo}-${c.sha}`}
          className="flex items-center gap-3 px-3 py-1.5 text-sm"
        >
          <GitCommitHorizontalIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <a
            href={c.url}
            {...external}
            className="shrink-0 font-mono text-xs text-muted-foreground hover:underline"
          >
            {c.sha.slice(0, 7)}
          </a>
          <span className="min-w-0 flex-1 truncate">{c.message}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {[
              c.author,
              c.committedAt && dateFormat.format(new Date(c.committedAt)),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
      {git.commits.length > COMMITS_SHOWN && (
        <li className="px-1 py-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setAllCommits((v) => !v)}
          >
            {allCommits
              ? "Show fewer commits"
              : `Show all ${git.commits.length} commits`}
          </Button>
        </li>
      )}
    </ul>
  );
}

/** The "Development" section of the task page. */
export function Development({
  orgSlug,
  taskKey,
}: {
  orgSlug: string;
  taskKey: string;
}) {
  const { data: git } = useQuery(taskGitQuery(orgSlug, taskKey));
  if (!git) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Development</h2>
      <DevelopmentLinks git={git} />
    </section>
  );
}
