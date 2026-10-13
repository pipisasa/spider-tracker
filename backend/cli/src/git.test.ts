import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrSwitchBranch,
  currentBranch,
  isDirty,
  remoteRepo,
  repoFromRemoteUrl,
  taskKeyFromBranch,
  type GitRunner,
} from "./git";

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

  test.each(["main", "feature/login", "st-", "12-st", "st-12345678901"])(
    "%s has no key",
    (branch) => {
      expect(taskKeyFromBranch(branch)).toBeNull();
    },
  );
});

describe("currentBranch", () => {
  test("reads the checked-out branch, or null outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "spider-cli-"));
    try {
      expect(currentBranch(dir)).toBeNull();
      Bun.spawnSync({
        cmd: ["git", "init", "-q", "-b", "st-42-branch-key"],
        cwd: dir,
      });
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
    return stdout === undefined
      ? { exitCode: 1, stdout: "", stderr: "fatal" }
      : { exitCode: 0, stdout, stderr: "" };
  };
  return { git, calls };
}

describe("remoteRepo", () => {
  test.each([
    [
      "https://github.com/pipisasa/spider-tracker.git",
      "pipisasa/spider-tracker",
    ],
    ["https://github.com/pipisasa/spider-tracker", "pipisasa/spider-tracker"],
    [
      "https://token@github.com/pipisasa/spider-tracker.git",
      "pipisasa/spider-tracker",
    ],
    ["git@github.com:pipisasa/spider-tracker.git", "pipisasa/spider-tracker"],
    [
      "ssh://git@github.com/pipisasa/spider-tracker.git",
      "pipisasa/spider-tracker",
    ],
    [
      "ssh://git@github.com:22/pipisasa/spider.tracker",
      "pipisasa/spider.tracker",
    ],
  ])("%s → %s", (url, repo) => {
    expect(repoFromRemoteUrl(url)).toBe(repo);
  });

  test.each(["", "/srv/git/repo.git", "https://gitlab.com/group/sub/repo.git"])(
    "%s has no owner/name",
    (url) => {
      expect(repoFromRemoteUrl(url)).toBeNull();
    },
  );

  test("reads origin, or null without one", () => {
    expect(
      remoteRepo(
        "/work",
        fakeGit({ "remote get-url origin": "git@github.com:o/r.git\n" }).git,
      ),
    ).toBe("o/r");
    expect(remoteRepo("/work", fakeGit({}).git)).toBeNull();
  });
});

describe("branches", () => {
  test("createOrSwitchBranch creates a missing branch and switches to an existing one", () => {
    const missing = fakeGit({ "switch -c st-1-x": "" });
    expect(createOrSwitchBranch("/work", "st-1-x", missing.git)).toEqual({
      created: true,
      tracking: null,
    });
    expect(missing.calls).toEqual([
      "rev-parse --verify --quiet refs/heads/st-1-x",
      "rev-parse --verify --quiet refs/remotes/origin/st-1-x",
      "switch -c st-1-x",
    ]);

    const existing = fakeGit({
      "rev-parse --verify --quiet refs/heads/st-1-x": "abc\n",
      "switch st-1-x": "",
    });
    expect(createOrSwitchBranch("/work", "st-1-x", existing.git)).toEqual({
      created: false,
      tracking: null,
    });
    expect(existing.calls).toEqual([
      "rev-parse --verify --quiet refs/heads/st-1-x",
      "switch st-1-x",
    ]);

    expect(() =>
      createOrSwitchBranch("/work", "st-1-x", fakeGit({}).git),
    ).toThrow("fatal");
  });

  test("createOrSwitchBranch tracks a branch that exists only on origin instead of branching from HEAD", () => {
    const remote = fakeGit({
      "rev-parse --verify --quiet refs/remotes/origin/st-1-x": "abc\n",
      "switch -c st-1-x --track origin/st-1-x": "",
    });
    expect(createOrSwitchBranch("/work", "st-1-x", remote.git)).toEqual({
      created: true,
      tracking: "origin/st-1-x",
    });
    expect(remote.calls.at(-1)).toBe("switch -c st-1-x --track origin/st-1-x");
  });

  test("createOrSwitchBranch tracks origin in a real repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "spider-cli-"));
    const sh = (cmd: string[], cwd = dir) => {
      const result = Bun.spawnSync({
        cmd,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      const origin = join(dir, "origin");
      const clone = join(dir, "clone");
      const id = [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
      ];
      sh(["git", "init", "-q", "-b", "main", origin]);
      sh(
        ["git", ...id, "commit", "-q", "--allow-empty", "-m", "first"],
        origin,
      );
      sh(["git", "branch", "st-1-x"], origin);
      sh(
        ["git", ...id, "commit", "-q", "--allow-empty", "-m", "main moves on"],
        origin,
      );
      sh(["git", "clone", "-q", origin, clone]);

      expect(createOrSwitchBranch(clone, "st-1-x")).toEqual({
        created: true,
        tracking: "origin/st-1-x",
      });
      expect(currentBranch(clone)).toBe("st-1-x");
      expect(
        sh(["git", "rev-parse", "--abbrev-ref", "st-1-x@{upstream}"], clone),
      ).toBe("origin/st-1-x");
      expect(sh(["git", "rev-parse", "HEAD"], clone)).toBe(
        sh(["git", "rev-parse", "origin/st-1-x"], clone),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isDirty looks at tracked changes", () => {
    expect(
      isDirty(
        "/work",
        fakeGit({ "status --porcelain --untracked-files=no": " M a.ts\n" }).git,
      ),
    ).toBe(true);
    expect(
      isDirty(
        "/work",
        fakeGit({ "status --porcelain --untracked-files=no": "" }).git,
      ),
    ).toBe(false);
  });
});
