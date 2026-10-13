import {
  DomainError,
  type GithubInstallationData,
  type GithubPullRequestData,
  type GithubPullRequestRequest,
  type GithubRepoData,
} from "@repo/core";
import { GithubUnavailableError, type GithubApp } from "./github";

/**
 * An in-memory GitHub for tests (ST-82): installations with their repositories, and OAuth codes
 * that name the installations their person can access. Codes are single-use, as on GitHub.
 */
export interface FakeGithub extends GithubApp {
  installations: Map<
    number,
    { installation: GithubInstallationData; repos: GithubRepoData[] }
  >;
  /** code → installation ids the person who got it can access. */
  codes: Map<string, number[]>;
  /** When set, every call fails as if GitHub were down. */
  down: boolean;
  /** Pull requests by repo ("owner/name", lower case), as createPullRequest opened them (ST-87). */
  pullRequests: Map<string, GithubPullRequestData[]>;
  /** Every createPullRequest request, in order. */
  pullRequestRequests: GithubPullRequestRequest[];
  /** When set, GitHub refuses new pull requests with this reason (a 422), e.g. "No commits between main and x". */
  refusePullRequests: string | null;
}

export function createFakeGithub(slug = "spider-tracker-test"): FakeGithub {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const fake: FakeGithub = {
    slug,
    installations: new Map(),
    codes: new Map(),
    down: false,
    pullRequests: new Map(),
    pullRequestRequests: [],
    refusePullRequests: null,
    installUrl: (state) =>
      `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
    async userCanAccessInstallation(code, installationId) {
      if (fake.down)
        throw new GithubUnavailableError(
          "GitHub request failed: OAuth code exchange",
        );
      const ids = fake.codes.get(code);
      fake.codes.delete(code);
      return ids?.includes(installationId) ?? false;
    },
    async getInstallation(installationId) {
      if (fake.down)
        throw new GithubUnavailableError("GitHub request failed: installation");
      return fake.installations.get(installationId)?.installation ?? null;
    },
    async listInstallationRepos(installationId) {
      if (fake.down)
        throw new GithubUnavailableError(
          "GitHub request failed: installation repositories",
        );
      return fake.installations.get(installationId)?.repos ?? [];
    },
    async createPullRequest(request) {
      fake.pullRequestRequests.push(request);
      if (fake.down)
        throw new GithubUnavailableError(
          "GitHub request failed: create pull request",
        );
      const repo = `${request.owner}/${request.name}`.toLowerCase();
      const list = fake.pullRequests.get(repo) ?? [];
      const open = list.find(
        (pr) => pr.state === "open" && pr.headBranch === request.head,
      );
      if (open) return { created: false, pullRequest: open };
      if (fake.refusePullRequests)
        throw new DomainError(
          "validation",
          `GitHub refused the pull request: ${fake.refusePullRequests}`,
        );
      clock += 1000;
      const pullRequest: GithubPullRequestData = {
        number: list.length + 1,
        title: request.title,
        body: request.body,
        state: "open",
        merged: false,
        draft: request.draft,
        headBranch: request.head,
        baseBranch: request.base,
        author: `${slug}[bot]`,
        mergedAt: null,
        closedAt: null,
        updatedAt: new Date(clock).toISOString(),
      };
      fake.pullRequests.set(repo, [...list, pullRequest]);
      return { created: true, pullRequest };
    },
  };
  return fake;
}
