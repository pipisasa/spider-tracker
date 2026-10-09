import { parseTaskKey } from "@repo/core/schemas";

/** A task key at the start of the branch name or after a separator, e.g. "st-12-fix" or "feat/ST-12". */
const KEY_IN_BRANCH = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d{1,9})(?!\d)/;

/** The task key a branch name refers to ("st-12-fix" → "ST-12"), or null. */
export function taskKeyFromBranch(branch: string): string | null {
  const match = KEY_IN_BRANCH.exec(branch);
  const parsed = match?.[1] ? parseTaskKey(match[1]) : null;
  return parsed ? `${parsed.projectKey}-${parsed.number}` : null;
}

/** The checked-out branch in `cwd`, or null outside a repository or on a detached HEAD. */
export function currentBranch(cwd: string): string | null {
  try {
    const result = Bun.spawnSync({ cmd: ["git", "branch", "--show-current"], cwd, stdout: "pipe", stderr: "ignore" });
    const branch = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return branch || null;
  } catch {
    // git is not installed.
    return null;
  }
}
