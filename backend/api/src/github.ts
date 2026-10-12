import {
  DomainError,
  type CreatePullRequestResult,
  type GithubInstallationData,
  type GithubPullRequestData,
  type GithubPullRequestRequest,
  type GithubRepoData,
} from "@repo/core";
import { App, Octokit, RequestError } from "octokit";
import { z } from "zod";
import type { GithubAppConfig } from "./env";

// The GitHub port (ST-82): everything the API asks GitHub, behind an interface so tests use a fake
// (github-fake.ts) and never reach the network. createGithubApp is the real one, on Octokit.

export interface GithubApp {
  /** The App's slug: github.com/apps/<slug>. */
  readonly slug: string;
  /** GitHub's page that installs the App; GitHub sends the person back to /github/setup with `state`. */
  installUrl(state: string): string;
  /**
   * Whether the person who authorized the App during installation (the OAuth `code` GitHub sends
   * to the setup callback) can access the installation. The code is used up.
   */
  userCanAccessInstallation(code: string, installationId: number): Promise<boolean>;
  /** The installation, or null when GitHub doesn't know it (uninstalled). */
  getInstallation(installationId: number): Promise<GithubInstallationData | null>;
  /** Every repository the installation grants. */
  listInstallationRepos(installationId: number): Promise<GithubRepoData[]>;
  /**
   * Opens a pull request as the App, with the installation's token (ST-87). When one is already
   * open for the branch, returns it with `created: false`. GitHub refusing it (no commits, a branch
   * that isn't pushed) is a DomainError "validation" with GitHub's reason.
   */
  createPullRequest(request: GithubPullRequestRequest): Promise<CreatePullRequestResult>;
}

/** GitHub couldn't be reached or refused a request (the API answers 502). */
export class GithubUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GithubUnavailableError";
  }
}

type Account = { login: string } | { slug: string; name: string } | null | undefined;

const accountLogin = (account: Account) => (!account ? "" : "login" in account ? account.login : account.slug);

/** Wraps GitHub failures so routes can tell them from bugs. */
async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new GithubUnavailableError(`GitHub request failed: ${what}`, { cause: err });
  }
}

/** A pull request in GitHub's REST answers: only the fields used. */
interface RestPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  draft?: boolean;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  head: { ref: string };
  base: { ref: string };
  user: { login: string } | null;
}

export const toPullRequestData = (pr: RestPullRequest): GithubPullRequestData => ({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  state: pr.state === "closed" ? "closed" : "open",
  merged: pr.merged === true || pr.merged_at !== null,
  draft: pr.draft ?? false,
  headBranch: pr.head.ref,
  baseBranch: pr.base.ref,
  author: pr.user?.login ?? null,
  mergedAt: pr.merged_at,
  closedAt: pr.closed_at,
  updatedAt: pr.updated_at,
});

/** GitHub's 422 body: "Validation Failed" with the reasons in `errors`. */
const validationFailed = z.object({
  message: z.string().optional(),
  errors: z
    .array(z.union([z.string(), z.object({ message: z.string().optional(), field: z.string().optional(), code: z.string().optional() })]))
    .optional(),
});

/** GitHub's reasons for refusing a request (422), joined. */
export function githubReasons(data: unknown): string {
  const parsed = validationFailed.safeParse(data);
  if (!parsed.success) return "Validation Failed";
  const reasons = (parsed.data.errors ?? []).map((e) =>
    typeof e === "string" ? e : (e.message ?? [e.field, e.code].filter(Boolean).join(" ")),
  );
  return reasons.filter(Boolean).join("; ") || parsed.data.message || "Validation Failed";
}

export function createGithubApp(config: GithubAppConfig): GithubApp {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    oauth: { clientId: config.clientId, clientSecret: config.clientSecret },
  });

  return {
    slug: config.slug,

    installUrl: (state) => `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`,

    async userCanAccessInstallation(code, installationId) {
      const token = await app.oauth.createToken({ code }).then(
        (r) => r.authentication.token,
        // An invalid or used code: the person isn't verified.
        (err: unknown) => {
          if (err instanceof RequestError && err.status < 500) return null;
          if (err instanceof Error && /bad_verification_code|incorrect or expired/i.test(err.message)) return null;
          throw new GithubUnavailableError("GitHub request failed: OAuth code exchange", { cause: err });
        },
      );
      if (!token) return false;
      return guarded("user installations", async () => {
        const user = new Octokit({ auth: token });
        for await (const { data } of user.paginate.iterator("GET /user/installations", { per_page: 100 })) {
          if (data.some((i) => i.id === installationId)) return true;
        }
        return false;
      });
    },

    getInstallation: (installationId) =>
      guarded("installation", async () => {
        try {
          const { data } = await app.octokit.request("GET /app/installations/{installation_id}", { installation_id: installationId });
          return {
            id: data.id,
            account: accountLogin(data.account),
            accountType: data.target_type === "Organization" ? "Organization" : "User",
            repositorySelection: data.repository_selection,
            suspended: data.suspended_at !== null && data.suspended_at !== undefined,
          };
        } catch (err) {
          if (err instanceof RequestError && err.status === 404) return null;
          throw err;
        }
      }),

    listInstallationRepos: (installationId) =>
      guarded("installation repositories", async () => {
        const octokit = await app.getInstallationOctokit(installationId);
        const repos = await octokit.paginate("GET /installation/repositories", { per_page: 100 });
        return repos.map((r) => ({ owner: r.owner.login, name: r.name, defaultBranch: r.default_branch }));
      }),

    async createPullRequest({ installationId, owner, name, head, base, title, body, draft }) {
      const octokit = await guarded("installation token", () => app.getInstallationOctokit(installationId));
      try {
        const { data } = await octokit.request("POST /repos/{owner}/{repo}/pulls", { owner, repo: name, head, base, title, body, draft });
        return { created: true, pullRequest: toPullRequestData(data) };
      } catch (err) {
        if (!(err instanceof RequestError) || err.status !== 422) {
          throw new GithubUnavailableError("GitHub request failed: create pull request", { cause: err });
        }
        const reasons = githubReasons(err.response?.data);
        if (!/already exists/i.test(reasons)) throw new DomainError("validation", `GitHub refused the pull request: ${reasons}`);
      }
      // Already open for the branch: GitHub's own.
      return guarded("open pull requests", async () => {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner, repo: name, head: `${owner}:${head}`, state: "open", per_page: 1 });
        const [open] = data;
        if (!open) throw new Error(`GitHub reported an open pull request for ${head} but lists none`);
        return { created: false, pullRequest: toPullRequestData(open) };
      });
    },
  };
}
