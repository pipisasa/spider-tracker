import { parseRepoRemote, repoFullName } from "@repo/core/git";

export { taskKeyFromBranch } from "@repo/core/git";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `git <args>` in `cwd`, with `env` added to the environment; injected in tests so they never
 * touch a real repository.
 */
export type GitRunner = (
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) => GitResult;

export const runGit: GitRunner = (args, cwd, env) => {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch {
    // git is not installed.
    return { exitCode: 127, stdout: "", stderr: "git not found" };
  }
};

/** The checked-out branch in `cwd`, or null outside a repository or on a detached HEAD. */
export function currentBranch(
  cwd: string,
  git: GitRunner = runGit,
): string | null {
  const result = git(["branch", "--show-current"], cwd);
  const branch = result.exitCode === 0 ? result.stdout.trim() : "";
  return branch || null;
}

/** `cwd` is inside a git working tree. */
export function isRepo(cwd: string, git: GitRunner = runGit): boolean {
  const result = git(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Tracked files have uncommitted changes (untracked files don't count). */
export function isDirty(cwd: string, git: GitRunner = runGit): boolean {
  const result = git(["status", "--porcelain", "--untracked-files=no"], cwd);
  return result.exitCode === 0 && result.stdout.trim() !== "";
}

/** Never ask for credentials on a terminal: a fetch that needs them fails instead (ST-126). */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

/**
 * Fetches branch `name` from `origin` (`spider start --fetch`), so a branch pushed from another
 * machine is seen as `origin/<name>`. Whether origin has it is asked first (`git ls-remote
 * --exit-code`, exit 2 when it doesn't: no message parsing, any locale), so a missing branch isn't an
 * error (`missing`). The fetch names the full refspec, so single-branch clones get
 * `refs/remotes/origin/<name>` too. Other failures (no network, no origin) are returned for a warning.
 */
export function fetchBranch(
  cwd: string,
  name: string,
  git: GitRunner = runGit,
): { ok: true } | { ok: false; missing: boolean; error: string } {
  const failed = (result: GitResult, what: string) => ({
    ok: false as const,
    missing: false,
    error: result.stderr.trim() || `${what} failed (exit ${result.exitCode})`,
  });
  const listed = git(
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${name}`],
    cwd,
    NO_PROMPT,
  );
  if (listed.exitCode === 2)
    return { ok: false, missing: true, error: `origin has no branch ${name}` };
  if (listed.exitCode !== 0) return failed(listed, "git ls-remote origin");
  const fetched = git(
    [
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${name}:refs/remotes/origin/${name}`,
    ],
    cwd,
    NO_PROMPT,
  );
  return fetched.exitCode === 0
    ? { ok: true }
    : failed(fetched, `git fetch origin ${name}`);
}

/**
 * Switches to branch `name`: the local branch when it exists, else a new local branch tracking `origin/<name>` when
 * only the remote one exists, else a new branch from HEAD. Throws with git's message on failure.
 * Only what git already knows of origin counts: a branch pushed elsewhere and not fetched yet is
 * created from HEAD (fetch first, or `fetchBranch`).
 */
export function createOrSwitchBranch(
  cwd: string,
  name: string,
  git: GitRunner = runGit,
): { created: boolean; tracking: string | null } {
  const has = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", ref], cwd).exitCode === 0;
  const local = has(`refs/heads/${name}`);
  const tracking =
    !local && has(`refs/remotes/origin/${name}`) ? `origin/${name}` : null;
  const args = local
    ? ["switch", name]
    : tracking
      ? ["switch", "-c", name, "--track", tracking]
      : ["switch", "-c", name];
  const result = git(args, cwd);
  if (result.exitCode !== 0) {
    // A single-branch clone's fetch refspec doesn't cover origin/<name>, so --track refuses it
    // ("starting point … is not a branch"): branch from it and set the upstream explicitly.
    if (tracking && trackExplicitly(cwd, name, tracking, git))
      return { created: true, tracking };
    throw new Error(result.stderr.trim() || `git switch ${name} failed`);
  }
  return { created: !local, tracking };
}

/** `git switch -c <name> --no-track <start>` plus the upstream config `--track` would write. */
function trackExplicitly(
  cwd: string,
  name: string,
  start: string,
  git: GitRunner,
): boolean {
  if (git(["switch", "-c", name, "--no-track", start], cwd).exitCode !== 0)
    return false;
  git(["config", `branch.${name}.remote`, "origin"], cwd);
  git(["config", `branch.${name}.merge`, `refs/heads/${name}`], cwd);
  return true;
}

/** "owner/name" from a GitHub remote URL (https, ssh or scp-like), or null. */
export function repoFromRemoteUrl(url: string): string | null {
  const remote = parseRepoRemote(url);
  return remote ? repoFullName(remote) : null;
}

/** The `origin` remote's URL in `cwd`, or null. */
export function originUrl(cwd: string, git: GitRunner = runGit): string | null {
  const result = git(["remote", "get-url", "origin"], cwd);
  return result.exitCode === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : null;
}

/** The "owner/name" of the `origin` remote in `cwd`, or null. */
export function remoteRepo(
  cwd: string,
  git: GitRunner = runGit,
): string | null {
  const url = originUrl(cwd, git);
  return url ? repoFromRemoteUrl(url) : null;
}

/** Pushes `branch` to `origin` and sets it as the upstream (`spider pr`), with the person's own git and credentials. Throws with git's message on failure. */
export function pushBranch(
  cwd: string,
  branch: string,
  git: GitRunner = runGit,
): void {
  const result = git(["push", "--set-upstream", "origin", branch], cwd);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git push origin ${branch} failed`);
}

const ORIGIN_REFS = "refs/remotes/origin/";

/**
 * The origin remote's default branch ("main" from `refs/remotes/origin/HEAD`), or null when git
 * doesn't know it (a clone that never set it). Reads the full ref: `--short` prints
 * `remotes/origin/main` when a local branch named `origin/main` exists (ST-146).
 */
export function originDefaultBranch(
  cwd: string,
  git: GitRunner = runGit,
): string | null {
  const result = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  const ref = result.exitCode === 0 ? result.stdout.trim() : "";
  return ref.startsWith(ORIGIN_REFS) && ref.length > ORIGIN_REFS.length
    ? ref.slice(ORIGIN_REFS.length)
    : null;
}
