import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, taskKeyFromBranch } from "./git";

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
