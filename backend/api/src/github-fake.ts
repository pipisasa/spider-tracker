import type { GithubInstallationData, GithubRepoData } from "@repo/core";
import { GithubUnavailableError, type GithubApp } from "./github";

/**
 * An in-memory GitHub for tests (ST-82): installations with their repositories, and OAuth codes
 * that name the installations their person can access. Codes are single-use, as on GitHub.
 */
export interface FakeGithub extends GithubApp {
  installations: Map<number, { installation: GithubInstallationData; repos: GithubRepoData[] }>;
  /** code → installation ids the person who got it can access. */
  codes: Map<string, number[]>;
  /** When set, every call fails as if GitHub were down. */
  down: boolean;
}

export function createFakeGithub(slug = "spider-tracker-test"): FakeGithub {
  const fake: FakeGithub = {
    slug,
    installations: new Map(),
    codes: new Map(),
    down: false,
    installUrl: (state) => `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
    async userCanAccessInstallation(code, installationId) {
      if (fake.down) throw new GithubUnavailableError("GitHub request failed: OAuth code exchange");
      const ids = fake.codes.get(code);
      fake.codes.delete(code);
      return ids?.includes(installationId) ?? false;
    },
    async getInstallation(installationId) {
      if (fake.down) throw new GithubUnavailableError("GitHub request failed: installation");
      return fake.installations.get(installationId)?.installation ?? null;
    },
    async listInstallationRepos(installationId) {
      if (fake.down) throw new GithubUnavailableError("GitHub request failed: installation repositories");
      return fake.installations.get(installationId)?.repos ?? [];
    },
  };
  return fake;
}
