// Local git for releases (ST-95): each app's range (its previous tag → the release's tag or the
// branch) and the commits in it, for `spider release check`, `changelog` and `notes`. Every git
// call goes through the injected runner, so tests fake it. GitHub commit links (ST-84) can replace
// this once they land.
import type { AppDto, ReleaseDto, RepoDto } from "@repo/core/contracts";
import { gitLogArgs, isBranchMerge, parseGitLog, type AppRange, type GitCommit } from "@repo/core/release-check";
import { previousTag, releaseTag } from "@repo/core/release-notes";
import { remoteRepo, type GitRunner } from "./git";
import { CliError, EXIT, usageError } from "./resolve";

export interface ScanOptions {
  /** The branch or commit to check up to when an app's release tag doesn't exist yet (default: the repo's default branch). */
  ref?: string;
  /** The start of the range for apps that were never tagged (default: their whole history). */
  since?: string;
}

export interface RepoScan {
  /** "owner/name" of the repo checked (this folder's origin). */
  repo: string;
  /** One per app of the repo, the release's and the others. */
  ranges: AppRange[];
  /** The release's apps in other repos. */
  skippedApps: { name: string; repo: string }[];
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The release's repo this folder is a clone of (its origin remote), or a usage error saying why not. */
export function releaseRepoHere(release: ReleaseDto, cwd: string, git: GitRunner): string {
  const linked = [...new Set([...release.repos.map((r) => r.fullName), ...release.apps.map((a) => a.repo)])];
  if (linked.length === 0) {
    throw usageError(`${release.key} links no repos or apps yet. Add them first: spider release update ${release.key} --app web=<version>`);
  }
  const origin = remoteRepo(cwd, git);
  const match = origin ? linked.find((r) => sameRepo(r, origin)) : undefined;
  if (!match) {
    throw usageError(
      `${origin ? `This folder is a clone of ${origin}, but` : "This folder has no GitHub origin remote;"} ${release.key} ships from ${linked.join(", ")}. Run it in a clone of ${linked.length === 1 ? "it" : "one of them"}`,
    );
  }
  return match;
}

function gitOrFail(git: GitRunner, cwd: string, args: string[]): string {
  const result = git(args, cwd);
  if (result.exitCode !== 0) {
    throw new CliError(EXIT.unexpected, `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

const refExists = (git: GitRunner, cwd: string, ref: string) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).exitCode === 0;

/**
 * Each app of `repo` with its range and commits: from its previous tag (or `since`, or the whole
 * history) to the release's tag for it when that exists, else `ref` (the default branch). A merge
 * of a branch gets the files of its diff against the first parent.
 */
export function scanRepo(release: ReleaseDto, repo: RepoDto, cwd: string, git: GitRunner, options: ScanOptions = {}): RepoScan {
  const ref = options.ref ?? (refExists(git, cwd, `refs/heads/${repo.defaultBranch}`) ? repo.defaultBranch : "HEAD");
  if (!refExists(git, cwd, ref)) throw usageError(`No branch or commit "${ref}" in this repository`);
  if (options.since !== undefined && !refExists(git, cwd, options.since)) throw usageError(`No tag or commit "${options.since}" in this repository`);

  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const allTags = new Set(lines(gitOrFail(git, cwd, ["tag", "--list"])));
  const mergedTags = lines(gitOrFail(git, cwd, ["tag", "--list", "--merged", ref]));

  const logs = new Map<string, GitCommit[]>();
  const mergeFiles = new Map<string, string[]>();
  const commitsIn = (range: string) => {
    let commits = logs.get(range);
    if (!commits) {
      commits = parseGitLog(gitOrFail(git, cwd, gitLogArgs(range))).map((commit) => {
        if (!isBranchMerge(commit)) return commit;
        let files = mergeFiles.get(commit.sha);
        if (!files) {
          files = lines(gitOrFail(git, cwd, ["diff", "--name-only", `${commit.sha}^1`, commit.sha]));
          mergeFiles.set(commit.sha, files);
        }
        return { ...commit, files };
      });
      logs.set(range, commits);
    }
    return commits;
  };

  const ranges = repo.apps.map((app: AppDto): AppRange => {
    const shipped = release.apps.find((a) => sameRepo(a.repo, repo.fullName) && a.name === app.name);
    const version = shipped?.version ?? null;
    const tag = shipped ? releaseTag(app, shipped.version) : null;
    const until = tag && allTags.has(tag) ? tag : ref;
    const since = previousTag(app, mergedTags, version) ?? options.since ?? null;
    return {
      name: app.name,
      path: app.path,
      sharedPaths: app.sharedPaths,
      versioning: app.versioning,
      inRelease: shipped !== undefined,
      version,
      tag,
      since,
      until,
      commits: commitsIn(since ? `${since}..${until}` : until),
    };
  });
  const skippedApps = release.apps.filter((a) => !sameRepo(a.repo, repo.fullName)).map((a) => ({ name: a.name, repo: a.repo }));
  return { repo: repo.fullName, ranges, skippedApps };
}
