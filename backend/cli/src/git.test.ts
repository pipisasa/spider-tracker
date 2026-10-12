import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrSwitchBranch, currentBranch, isDirty, remoteRepo, repoFromRemoteUrl, taskKeyFromBranch, type GitRunner } from "./git";

describe("taskKeyFromBranch", () => {
  test.each([
    ["st-12-fix", "ST-12"],
    ["ST-12", "ST-12"],
    ["feat/st-7-cli", "ST-7"],
    ["pipi/SPI-123_login", "SPI-123"],
    ["fix-login-st-3", "ST-3"],
  ])("%s → %s", (branch, key) => {
    expect(taskKeyFromBranch(branch)).toBe(key);
  });

  test.each(["main", "feature/login", "st-", "12-st", "st-12345678901"])("%s has no key", (branch) => {
    expect(taskKeyFromBranch(branch)).toBeNull();
  });
});

describe("currentBranch", () => {
  test("reads the checked-out branch, or null outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "spider-cli-"));
    try {
      expect(currentBranch(dir)).toBeNull();
      Bun.spawnSync({ cmd: ["git", "init", "-q", "-b", "st-42-branch-key"], cwd: dir });
      expect(currentBranch(dir)).toBe("st-42-branch-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Answers git commands from a table ("args joined by spaces" → stdout; missing → exit 1) and records them. */
function fakeGit(answers: Record<string, string>) {
  const calls: string[] = [];
  const git: GitRunner = (args) => {
    const command = args.join(" ");
    calls.push(command);
    const stdout = answers[command];
    return stdout === undefined ? { exitCode: 1, stdout: "", stderr: "fatal" } : { exitCode: 0, stdout, stderr: "" };
  };
  return { git, calls };
}

describe("remoteRepo", () => {
  test.each([
    ["https://github.com/pipisasa/spider-tracker.git", "pipisasa/spider-tracker"],
    ["https://github.com/pipisasa/spider-tracker", "pipisasa/spider-tracker"],
    ["https://token@github.com/pipisasa/spider-tracker.git", "pipisasa/spider-tracker"],
    ["git@github.com:pipisasa/spider-tracker.git", "pipisasa/spider-tracker"],
    ["ssh://git@github.com/pipisasa/spider-tracker.git", "pipisasa/spider-tracker"],
    ["ssh://git@github.com:22/pipisasa/spider.tracker", "pipisasa/spider.tracker"],
  ])("%s → %s", (url, repo) => {
    expect(repoFromRemoteUrl(url)).toBe(repo);
  });

  test.each(["", "/srv/git/repo.git", "https://gitlab.com/group/sub/repo.git"])("%s has no owner/name", (url) => {
    expect(repoFromRemoteUrl(url)).toBeNull();
  });

  test("reads origin, or null without one", () => {
    expect(remoteRepo("/work", fakeGit({ "remote get-url origin": "git@github.com:o/r.git\n" }).git)).toBe("o/r");
    expect(remoteRepo("/work", fakeGit({}).git)).toBeNull();
  });
});

describe("branches", () => {
  test("createOrSwitchBranch creates a missing branch and switches to an existing one", () => {
    const missing = fakeGit({ "switch -c st-1-x": "" });
    expect(createOrSwitchBranch("/work", "st-1-x", missing.git)).toEqual({ created: true });
    expect(missing.calls).toEqual(["rev-parse --verify --quiet refs/heads/st-1-x", "switch -c st-1-x"]);

    const existing = fakeGit({ "rev-parse --verify --quiet refs/heads/st-1-x": "abc\n", "switch st-1-x": "" });
    expect(createOrSwitchBranch("/work", "st-1-x", existing.git)).toEqual({ created: false });
    expect(existing.calls.at(-1)).toBe("switch st-1-x");

    expect(() => createOrSwitchBranch("/work", "st-1-x", fakeGit({}).git)).toThrow("fatal");
  });

  test("isDirty looks at tracked changes", () => {
    expect(isDirty("/work", fakeGit({ "status --porcelain --untracked-files=no": " M a.ts\n" }).git)).toBe(true);
    expect(isDirty("/work", fakeGit({ "status --porcelain --untracked-files=no": "" }).git)).toBe(false);
  });
});
