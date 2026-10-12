// The release git check (ST-95). Browser-safe (no database): the CLI runs `git log` for each app's
// range (previous tag → the release's tag or branch) and this module compares the commits with the
// release's tasks. Task keys come from commit messages and merged branch names (ST-81); files map
// to apps by their folder and shared paths (ST-92).
import type { AppVersioning, ReleaseCheckAppDto, ReleaseCheckDto } from "./contracts";
import { closingKeysIn, taskKeyFromBranch, taskKeysIn } from "./git";

export interface GitCommit {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
  /** Changed files; for a merge, filled in from its diff against the first parent when wanted. */
  files: string[];
}

/** `git log` arguments for `range` ("web-2026.10.12..main", or a ref alone for its whole history). */
export function gitLogArgs(range: string): string[] {
  return ["log", "--no-color", "--format=%x1e%H%x1f%P%x1f%s%x1f%b%x1f", "--name-only", range];
}

/** Commits from `git log` run with `gitLogArgs`, newest first. */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split("\x1e")) {
    if (!record.trim()) continue;
    const [sha = "", parents = "", subject = "", body = "", files = ""] = record.split("\x1f");
    if (!/^[0-9a-f]{7,64}$/.test(sha.trim())) continue;
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      subject: subject.trim(),
      body: body.trim(),
      files: files
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

/**
 * The branch a merge commit brought in: "Merge branch 'st-12-x'", "Merge branch 'st-12-x' of
 * github.com:o/r", "Merge pull request #4 from o/st-12-x". Null for other subjects, and for merges
 * into another branch ("Merge branch 'main' into st-12-x"), whose diff isn't the branch's work.
 */
export function mergedBranch(subject: string): string | null {
  const branch = /^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?$/.exec(subject.trim());
  if (branch?.[1]) return branch[1].replace(/^origin\//, "");
  const pr = /^Merge pull request #\d+ from [^/\s]+\/(\S+)$/.exec(subject.trim());
  return pr?.[1] ?? null;
}

/** A merge whose diff against its first parent is a branch's work, so its files count. */
export const isBranchMerge = (commit: GitCommit) => commit.parents.length > 1 && mergedBranch(commit.subject) !== null;

/**
 * The task keys a commit is for: keys in its subject ("feat: x (ST-12)"), keys the body closes
 * ("Fixes ST-12"), and the key of the branch it merges. Other keys in the body are only mentions
 * ("the seam for ST-84") and don't count. With `projects`, only keys of those projects ("UTF-8").
 */
export function releaseCommitKeys(commit: GitCommit, projects?: Set<string>): string[] {
  const keys = new Set([...taskKeysIn(commit.subject), ...closingKeysIn(commit.body)]);
  const branch = mergedBranch(commit.subject);
  const branchKey = branch ? taskKeyFromBranch(branch) : null;
  if (branchKey) keys.add(branchKey);
  return [...keys].filter((k) => !projects || projects.has(k.split("-")[0] ?? ""));
}

export interface CheckedApp {
  name: string;
  /** Its folder in the repo ("." for the whole repo). */
  path: string;
  sharedPaths: string[];
}

const normalizePath = (path: string) => path.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/** `file` (relative to the repo root) is in the app's folder or one of its shared paths. */
export function touchesApp(app: CheckedApp, file: string): boolean {
  const f = normalizePath(file);
  return [app.path, ...app.sharedPaths].some((p) => {
    const dir = normalizePath(p);
    return dir === "" || dir === "." || f === dir || f.startsWith(`${dir}/`);
  });
}

/** One app's range and the commits git listed for it (all of them; `checkRelease` filters by path). */
export interface AppRange extends CheckedApp {
  versioning: AppVersioning;
  inRelease: boolean;
  version: string | null;
  tag: string | null;
  since: string | null;
  until: string;
  commits: GitCommit[];
}

const touching = (range: AppRange) => range.commits.filter((c) => c.files.some((f) => touchesApp(range, f)));

/** Task key → the apps (of `ranges`) whose commits touching them mention it. */
export function taskAppsFrom(ranges: AppRange[], projects?: Set<string>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const range of ranges) {
    for (const commit of touching(range)) {
      for (const key of releaseCommitKeys(commit, projects)) {
        const apps = (result[key] ??= []);
        if (!apps.includes(range.name)) apps.push(range.name);
      }
    }
  }
  for (const apps of Object.values(result)) apps.sort();
  return result;
}

const byKey = (a: { key: string }, b: { key: string }) => {
  const [pa = "", na = "0"] = a.key.split("-");
  const [pb = "", nb = "0"] = b.key.split("-");
  return pa.localeCompare(pb) || Number(na) - Number(nb);
};

const sortKeys = (keys: Iterable<string>) => [...new Set(keys)].map((key) => ({ key })).sort(byKey).map((k) => k.key);

/**
 * Compares the commits of each app's range with the release's tasks:
 * - left out: candidates whose commits touch one of the release's apps;
 * - no commits: included tasks no commit in the release apps' ranges mentions (touching files or not);
 * - apps not in the release: the repo's other apps with commits since their previous tag.
 */
export function checkRelease(input: {
  release: { key: string; title: string };
  repo: string;
  ranges: AppRange[];
  included: { key: string; title: string }[];
  candidates: { key: string; title: string }[];
  /** Keys of the organization's projects, to ignore look-alikes ("UTF-8"). */
  projects?: Set<string>;
  skippedApps?: { name: string; repo: string }[];
}): ReleaseCheckDto {
  const { ranges, projects } = input;
  const apps: ReleaseCheckAppDto[] = ranges.map((range) => {
    const commits = touching(range);
    return {
      name: range.name,
      inRelease: range.inRelease,
      version: range.version,
      tag: range.tag,
      since: range.since,
      until: range.until,
      commits: commits.length,
      tasks: sortKeys(commits.flatMap((c) => releaseCommitKeys(c, projects))),
    };
  });

  const released = ranges.filter((r) => r.inRelease);
  const included = new Set(input.included.map((t) => t.key));
  const mentioned = new Set(released.flatMap((r) => r.commits.flatMap((c) => releaseCommitKeys(c, projects))));
  const touchedBy = new Map<string, { apps: Set<string>; commits: Set<string> }>();
  for (const range of released) {
    for (const commit of touching(range)) {
      for (const key of releaseCommitKeys(commit, projects)) {
        const entry = touchedBy.get(key) ?? { apps: new Set(), commits: new Set() };
        entry.apps.add(range.name);
        entry.commits.add(commit.sha.slice(0, 7));
        touchedBy.set(key, entry);
      }
    }
  }

  const leftOut = input.candidates
    .filter((t) => !included.has(t.key) && touchedBy.has(t.key))
    .map((t) => ({ key: t.key, title: t.title, apps: [...(touchedBy.get(t.key)?.apps ?? [])].sort(), commits: [...(touchedBy.get(t.key)?.commits ?? [])] }))
    .sort(byKey);
  const noCommits = released.length ? input.included.filter((t) => !mentioned.has(t.key)).sort(byKey) : [];
  const appsNotInRelease = apps
    .filter((a) => !a.inRelease && a.commits > 0)
    .map((a) => ({ name: a.name, since: a.since, commits: a.commits, tasks: a.tasks }));

  return {
    release: input.release,
    repo: input.repo,
    ok: leftOut.length === 0 && noCommits.length === 0 && appsNotInRelease.length === 0,
    apps,
    leftOut,
    noCommits,
    appsNotInRelease,
    skippedApps: input.skippedApps ?? [],
  };
}
