import { describe, expect, test } from "bun:test";
import { checkRelease, releaseCommitKeys, gitLogArgs, mergedBranch, parseGitLog, taskAppsFrom, touchesApp, type AppRange, type GitCommit } from "./release-check";

/** `git log` output in the format of gitLogArgs. */
const log = (commits: { sha: string; parents?: string; subject: string; body?: string; files?: string[] }[]) =>
  commits.map((c) => `\x1e${c.sha}\x1f${c.parents ?? "p1"}\x1f${c.subject}\x1f${c.body ?? ""}\x1f\n\n${(c.files ?? []).join("\n")}\n`).join("");

describe("parsing git log", () => {
  test("commits with parents, message and files", () => {
    expect(gitLogArgs("web-2026.10.12..main")).toEqual([
      "log",
      "--no-color",
      "--format=%x1e%H%x1f%P%x1f%s%x1f%b%x1f",
      "--name-only",
      "web-2026.10.12..main",
    ]);
    const commits = parseGitLog(
      log([
        { sha: "aaaaaaa1", subject: "feat: board (ST-1)", body: "Details\n\nCloses ST-2", files: ["web/app/src/a.tsx", "packages/core/src/b.ts"] },
        { sha: "bbbbbbb2", parents: "p1 p2", subject: "Merge branch 'st-3-cli'" },
      ]),
    );
    expect(commits).toEqual([
      { sha: "aaaaaaa1", parents: ["p1"], subject: "feat: board (ST-1)", body: "Details\n\nCloses ST-2", files: ["web/app/src/a.tsx", "packages/core/src/b.ts"] },
      { sha: "bbbbbbb2", parents: ["p1", "p2"], subject: "Merge branch 'st-3-cli'", body: "", files: [] },
    ]);
    expect(parseGitLog("")).toEqual([]);
  });

  test("merged branches and task keys", () => {
    expect(mergedBranch("Merge branch 'st-93-releases'")).toBe("st-93-releases");
    expect(mergedBranch("Merge branch 'st-9-x' of github.com:o/r")).toBe("st-9-x");
    expect(mergedBranch("Merge remote-tracking branch 'origin/st-9-x'")).toBe("st-9-x");
    expect(mergedBranch("Merge pull request #12 from pipisasa/st-4-fix")).toBe("st-4-fix");
    expect(mergedBranch("Merge branch 'main' into st-93-releases")).toBeNull();
    expect(mergedBranch("feat: x")).toBeNull();

    const commit = (subject: string, body = ""): GitCommit => ({ sha: "c", parents: ["p"], subject, body, files: [] });
    expect(releaseCommitKeys(commit("feat: utf-8 names (ST-5)", "Fixes OPS-2"))).toEqual(["UTF-8", "ST-5", "OPS-2"]);
    expect(releaseCommitKeys(commit("feat: utf-8 names (ST-5)", "Fixes OPS-2"), new Set(["ST", "OPS"]))).toEqual(["ST-5", "OPS-2"]);
    expect(releaseCommitKeys({ ...commit("Merge branch 'st-7-cli'"), parents: ["a", "b"] })).toEqual(["ST-7"]);
    // A key only mentioned in the body isn't the commit's task.
    expect(releaseCommitKeys(commit("feat(github): webhooks (ST-83)", "githubEventHandlers is the seam for ST-84."))).toEqual(["ST-83"]);
  });

  test("files map to an app's folder and shared paths", () => {
    const web = { name: "web", path: "web/app", sharedPaths: ["packages/core/"] };
    expect(touchesApp(web, "web/app/src/x.tsx")).toBe(true);
    expect(touchesApp(web, "packages/core/src/y.ts")).toBe(true);
    expect(touchesApp(web, "web/application/z.ts")).toBe(false);
    expect(touchesApp(web, "backend/api/z.ts")).toBe(false);
    expect(touchesApp({ name: "site", path: ".", sharedPaths: [] }, "anything.md")).toBe(true);
  });
});

describe("checkRelease", () => {
  const commits = parseGitLog(
    log([
      { sha: "1111111a", subject: "feat(web): board (ST-1)", files: ["web/app/a.tsx"] },
      { sha: "2222222b", subject: "feat(core): shared rule (ST-2)", files: ["packages/core/x.ts"] },
      { sha: "3333333c", subject: "feat(cli): release check (ST-3)", files: ["backend/cli/c.ts"] },
      { sha: "4444444d", subject: "feat(api): webhook (ST-4)", files: ["backend/api/w.ts"] },
      { sha: "5555555e", subject: "docs: notes for ST-6", files: ["docs/x.md"] },
      { sha: "6666666f", subject: "chore: bump deps", files: ["bun.lock"] },
    ]),
  );
  const range = (name: string, path: string, inRelease: boolean, extra: Partial<AppRange> = {}): AppRange => ({
    name,
    path,
    sharedPaths: ["packages/core"],
    versioning: name === "cli" ? "semver" : "date",
    inRelease,
    version: inRelease ? (name === "cli" ? "0.1.9" : "2026.10.13") : null,
    tag: inRelease ? (name === "cli" ? "cli-v0.1.9" : "web-2026.10.13") : null,
    since: inRelease ? (name === "cli" ? "cli-v0.1.8" : "web-2026.10.01") : null,
    until: "main",
    commits,
    ...extra,
  });
  const ranges = [range("web", "web/app", true), range("cli", "backend/cli", true), range("api", "backend/api", false)];

  test("flags left-out candidates, included tasks without commits and changed apps outside the release", () => {
    const check = checkRelease({
      release: { key: "ST-120", title: "2026.10.13" },
      repo: "pipisasa/spider-tracker",
      ranges,
      included: [
        { key: "ST-1", title: "Board" },
        { key: "ST-6", title: "Docs" },
        { key: "ST-9", title: "Forgotten" },
      ],
      candidates: [
        { key: "ST-2", title: "Shared rule" },
        { key: "ST-3", title: "Release check" },
        { key: "ST-4", title: "Webhook" },
        { key: "ST-8", title: "Elsewhere" },
      ],
      projects: new Set(["ST"]),
      skippedApps: [{ name: "site", repo: "pipisasa/site" }],
    });
    expect(check.ok).toBe(false);
    expect(check.apps).toEqual([
      { name: "web", inRelease: true, version: "2026.10.13", tag: "web-2026.10.13", since: "web-2026.10.01", until: "main", commits: 2, tasks: ["ST-1", "ST-2"] },
      { name: "cli", inRelease: true, version: "0.1.9", tag: "cli-v0.1.9", since: "cli-v0.1.8", until: "main", commits: 2, tasks: ["ST-2", "ST-3"] },
      { name: "api", inRelease: false, version: null, tag: null, since: null, until: "main", commits: 2, tasks: ["ST-2", "ST-4"] },
    ]);
    expect(check.leftOut).toEqual([
      { key: "ST-2", title: "Shared rule", apps: ["cli", "web"], commits: ["2222222"] },
      { key: "ST-3", title: "Release check", apps: ["cli"], commits: ["3333333"] },
    ]);
    // ST-6 has a commit (outside every app), so only ST-9 has none.
    expect(check.noCommits).toEqual([{ key: "ST-9", title: "Forgotten" }]);
    expect(check.appsNotInRelease).toEqual([{ name: "api", since: null, commits: 2, tasks: ["ST-2", "ST-4"] }]);
    expect(check.skippedApps).toEqual([{ name: "site", repo: "pipisasa/site" }]);
  });

  test("ok when the release matches the commits", () => {
    const check = checkRelease({
      release: { key: "ST-120", title: "2026.10.13" },
      repo: "o/r",
      ranges: [range("cli", "backend/cli", true, { commits: commits.filter((c) => c.sha.startsWith("3")) })],
      included: [{ key: "ST-3", title: "Release check" }],
      candidates: [{ key: "ST-4", title: "Webhook" }],
    });
    expect(check).toMatchObject({ ok: true, leftOut: [], noCommits: [], appsNotInRelease: [] });
  });

  test("taskAppsFrom names the apps each task's commits touch", () => {
    expect(taskAppsFrom(ranges.filter((r) => r.inRelease), new Set(["ST"]))).toEqual({ "ST-1": ["web"], "ST-2": ["cli", "web"], "ST-3": ["cli"] });
  });
});
