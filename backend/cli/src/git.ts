export { taskKeyFromBranch } from "@repo/core/git";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`; injected in tests so they never touch a real repository. */
export type GitRunner = (args: string[], cwd: string) => GitResult;

export const runGit: GitRunner = (args, cwd) => {
  try {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch {
    // git is not installed.
    return { exitCode: 127, stdout: "", stderr: "git not found" };
  }
};

/** The checked-out branch in `cwd`, or null outside a repository or on a detached HEAD. */
export function currentBranch(cwd: string, git: GitRunner = runGit): string | null {
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

/**
 * Switches to branch `name`: the local branch when it exists, else a new local branch tracking `origin/<name>` when
 * only the remote one exists, else a new branch from HEAD. Throws with git's message on failure.
 */
export function createOrSwitchBranch(
  cwd: string,
  name: string,
  git: GitRunner = runGit,
): { created: boolean; tracking: string | null } {
  const has = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref], cwd).exitCode === 0;
  const local = has(`refs/heads/${name}`);
  const tracking = !local && has(`refs/remotes/origin/${name}`) ? `origin/${name}` : null;
  const args = local ? ["switch", name] : tracking ? ["switch", "-c", name, "--track", tracking] : ["switch", "-c", name];
  const result = git(args, cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git switch ${name} failed`);
  return { created: !local, tracking };
}

/** "owner/name" from a GitHub-style remote URL (https, ssh or scp-like), or null. */
export function repoFromRemoteUrl(url: string): string | null {
  const match = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@:/]+@[^:]+:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

/** The "owner/name" of the `origin` remote in `cwd`, or null. */
export function remoteRepo(cwd: string, git: GitRunner = runGit): string | null {
  const result = git(["remote", "get-url", "origin"], cwd);
  return result.exitCode === 0 ? repoFromRemoteUrl(result.stdout) : null;
}
