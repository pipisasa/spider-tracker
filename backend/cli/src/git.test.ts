import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrSwitchBranch,
  currentBranch,
  fetchBranch,
  isDirty,
  originDefaultBranch,
  remoteRepo,
  repoFromRemoteUrl,
  taskKeyFromBranch,
  type GitRunner,
} from "./git";

/**
 * The environment for real git in these tests, without GIT_* variables: run from a git hook,
 * GIT_DIR or GIT_WORK_TREE would point it at the outer repository (ST-126).
 */
const gitEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      !entry[0].startsWith("GIT_") && entry[1] !== undefined,
  ),
);

/** Real git with gitEnv, for the tests that need a repository. */
const realGit: GitRunner = (args, cwd, env) => {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: { ...gitEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

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
      expect(currentBranch(dir, realGit)).toBeNull();
      realGit(["init", "-q", "-b", "st-42-branch-key"], dir);
      expect(currentBranch(dir, realGit)).toBe("st-42-branch-key");
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

  test("originDefaultBranch reads the full ref of origin/HEAD (ST-146)", () => {
    const answer = (ref: string) =>
      originDefaultBranch(
        "/work",
        fakeGit({ "symbolic-ref refs/remotes/origin/HEAD": `${ref}\n` }).git,
      );
    expect(answer("refs/remotes/origin/main")).toBe("main");
    expect(answer("refs/remotes/origin/release/2026")).toBe("release/2026");
    expect(answer("refs/remotes/origin/")).toBeNull();
    expect(answer("refs/heads/main")).toBeNull();
    expect(originDefaultBranch("/work", fakeGit({}).git)).toBeNull();
  });

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

  test("createOrSwitchBranch falls back to explicit upstream config, and says when that fails (ST-126)", () => {
    const refused = "switch -c st-1-x --track origin/st-1-x";
    const base = {
      "rev-parse --verify --quiet refs/remotes/origin/st-1-x": "abc\n",
      "switch -c st-1-x --no-track origin/st-1-x": "",
    };
    // fakeGit answers only listed commands: --track is refused, as in a single-branch clone.
    const tracked = fakeGit({
      ...base,
      "config branch.st-1-x.remote origin": "",
      "config branch.st-1-x.merge refs/heads/st-1-x": "",
    });
    expect(createOrSwitchBranch("/work", "st-1-x", tracked.git)).toEqual({
      created: true,
      tracking: "origin/st-1-x",
    });
    expect(tracked.calls).toContain(refused);
    const noConfig = fakeGit(base);
    expect(createOrSwitchBranch("/work", "st-1-x", noConfig.git)).toEqual({
      created: true,
      tracking: null,
      warning:
        "created st-1-x from origin/st-1-x, but couldn't set its upstream; run git branch --set-upstream-to=origin/st-1-x",
    });
    expect(noConfig.calls.at(-1)).toBe("config branch.st-1-x.remote origin");
  });

  test("createOrSwitchBranch tracks origin in a real repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "spider-cli-"));
    const sh = (cmd: string[], cwd = dir) => {
      const [bin, ...args] = cmd;
      if (bin !== "git") throw new Error(`not git: ${cmd.join(" ")}`);
      const result = realGit(args, cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
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
      // Pushed from another machine after the clone: seen only after fetchBranch (ST-126), also
      // in a single-branch clone (the full refspec).
      const single = join(dir, "single");
      sh(["git", "clone", "-q", "--single-branch", origin, single]);
      sh(["git", "branch", "st-2-y"], origin);
      for (const repo of [clone, single]) {
        expect(fetchBranch(repo, "st-9-none", realGit)).toMatchObject({
          ok: false,
          missing: true,
        });
        expect(fetchBranch(repo, "st-2-y", realGit)).toEqual({ ok: true });
        expect(createOrSwitchBranch(repo, "st-2-y", realGit)).toEqual({
          created: true,
          tracking: "origin/st-2-y",
        });
        // Its upstream is set (a single-branch clone's refspec can't show it as @{upstream}).
        expect(sh(["git", "config", "branch.st-2-y.remote"], repo)).toBe(
          "origin",
        );
        expect(sh(["git", "config", "branch.st-2-y.merge"], repo)).toBe(
          "refs/heads/st-2-y",
        );
        sh(["git", "switch", "-q", "main"], repo);
      }

      expect(createOrSwitchBranch(clone, "st-1-x", realGit)).toEqual({
        created: true,
        tracking: "origin/st-1-x",
      });
      expect(currentBranch(clone, realGit)).toBe("st-1-x");
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

  test("fetchBranch asks origin first, never prompts, and reports other failures (ST-126)", () => {
    const calls: { args: string; env?: Record<string, string> }[] = [];
    const runner =
      (lsRemote: number, fetch = 0): GitRunner =>
      (args, _cwd, env) => {
        calls.push({ args: args.join(" "), env });
        const exitCode = args[0] === "ls-remote" ? lsRemote : fetch;
        return { exitCode, stdout: "", stderr: exitCode ? "fatal: boom" : "" };
      };
    expect(fetchBranch("/work", "st-1-x", runner(0))).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        args: "ls-remote --exit-code --heads origin refs/heads/st-1-x",
        env: { GIT_TERMINAL_PROMPT: "0" },
      },
      {
        args: "fetch --quiet origin +refs/heads/st-1-x:refs/remotes/origin/st-1-x",
        env: { GIT_TERMINAL_PROMPT: "0" },
      },
    ]);
    expect(fetchBranch("/work", "st-1-x", runner(2))).toMatchObject({
      ok: false,
      missing: true,
    });
    expect(fetchBranch("/work", "st-1-x", runner(128))).toEqual({
      ok: false,
      missing: false,
      error: "fatal: boom",
    });
    expect(fetchBranch("/work", "st-1-x", runner(0, 1))).toMatchObject({
      ok: false,
      missing: false,
    });
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
