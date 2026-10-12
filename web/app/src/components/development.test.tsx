import { expect, test } from "bun:test";
import type { TaskGitDto } from "@repo/core/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { DevelopmentLinks, pullRequestStatus } from "./development";

const empty: TaskGitDto = { taskKey: "ST-12", pullRequests: [], branches: [], commits: [] };

test("a pull request's state: open, draft, closed, merged", () => {
  expect(pullRequestStatus({ state: "open", draft: false }).label).toBe("Open");
  expect(pullRequestStatus({ state: "open", draft: true }).label).toBe("Draft");
  expect(pullRequestStatus({ state: "closed", draft: true }).label).toBe("Closed");
  expect(pullRequestStatus({ state: "merged", draft: false }).label).toBe("Merged");
});

test("with nothing linked, a hint names the task", () => {
  expect(renderToStaticMarkup(<DevelopmentLinks git={empty} />)).toContain("Branches named after ST-12");
});

test("lists pull requests, branches and the latest commits with links to GitHub", () => {
  const commits = Array.from({ length: 7 }, (_, i) => ({
    repo: "acme/web",
    sha: String(i).repeat(40),
    message: `Commit ${i}`,
    url: `https://github.com/acme/web/commit/${String(i).repeat(40)}`,
    author: "ann",
    committedAt: "2026-10-12T10:00:00.000Z",
    via: "branch" as const,
  }));
  const html = renderToStaticMarkup(
    <DevelopmentLinks
      git={{
        ...empty,
        pullRequests: [
          {
            repo: "acme/web",
            number: 7,
            title: "Ship <it>",
            url: "https://github.com/acme/web/pull/7",
            state: "merged",
            draft: false,
            headBranch: "st-12-ship-it",
            baseBranch: "main",
            author: "ann",
            mergedAt: "2026-10-12T12:00:00.000Z",
            closedAt: "2026-10-12T12:00:00.000Z",
            updatedAt: "2026-10-12T12:00:00.000Z",
            via: "branch",
          },
        ],
        branches: [{ repo: "acme/web", name: "st-12-ship-it", url: "https://github.com/acme/web/tree/st-12-ship-it", deleted: true, linkedAt: "2026-10-12T09:00:00.000Z" }],
        commits,
      }}
    />,
  );
  expect(html).toContain('href="https://github.com/acme/web/pull/7" target="_blank" rel="noopener noreferrer"');
  expect(html).toContain("Ship &lt;it&gt;");
  expect(html).toContain("Merged");
  expect(html).toContain("st-12-ship-it");
  expect(html).toContain("Deleted");
  // Five commits, then a button for the rest.
  expect(html).toContain("4444444");
  expect(html).not.toContain("5555555");
  expect(html).toContain("Show all 7 commits");
});
