import { describe, expect, test } from "bun:test";
import {
  branchNameFor,
  closingKeysIn,
  taskKeyFromBranch,
  taskKeysIn,
} from "./git";

describe("taskKeyFromBranch", () => {
  test.each([
    ["st-12-fix", "ST-12"],
    ["st-12-x", "ST-12"],
    ["ST-12", "ST-12"],
    ["ST-123", "ST-123"],
    ["feat/ST-12", "ST-12"],
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

describe("taskKeysIn", () => {
  test("PR titles and branch names", () => {
    expect(taskKeysIn("[ST-12] fix the login")).toEqual(["ST-12"]);
    expect(taskKeysIn("feat/st-12-x")).toEqual(["ST-12"]);
    expect(taskKeysIn("ST-123: board")).toEqual(["ST-123"]);
  });

  test("a commit message with several keys: unique, upper-cased, in order", () => {
    const message =
      "feat(web): board columns (st-3, ST-12)\n\nFollows ST-3; see also SPI-7 and spi-7.";
    expect(taskKeysIn(message)).toEqual(["ST-3", "ST-12", "SPI-7"]);
  });

  test("whole keys only", () => {
    expect(taskKeysIn("ST-1x 1ST-1 9ST-12")).toEqual([]);
    expect(taskKeysIn("xST-1")).toEqual(["XST-1"]);
    expect(taskKeysIn("ST-123")).not.toContain("ST-12");
    expect(taskKeysIn("ST-1234567890")).toEqual([]);
    expect(taskKeysIn("no keys here, ST- or -12")).toEqual([]);
  });

  test("matching is syntactic: UTF-8 and SHA-256 look like keys (unknown projects are filtered later)", () => {
    expect(taskKeysIn("UTF-8 text hashed with SHA-256")).toEqual([
      "UTF-8",
      "SHA-256",
    ]);
  });
});

describe("closingKeysIn", () => {
  test.each([
    ["Fixes ST-12", ["ST-12"]],
    ["fix st-12", ["ST-12"]],
    ["fixed ST-12", ["ST-12"]],
    ["Closes: ST-12", ["ST-12"]],
    ["close ST-12", ["ST-12"]],
    ["closed ST-12", ["ST-12"]],
    ["RESOLVES ST-12", ["ST-12"]],
    ["resolve ST-12 and resolved ST-4, fixes st-12", ["ST-12", "ST-4"]],
  ])("%s", (text, keys) => {
    expect(closingKeysIn(text)).toEqual(keys);
  });

  test("mentions without a keyword, or with a longer word, don't close", () => {
    expect(closingKeysIn("feat: board (ST-12)")).toEqual([]);
    expect(closingKeysIn("prefixes ST-12")).toEqual([]);
    expect(closingKeysIn("fixing ST-12")).toEqual([]);
    expect(closingKeysIn("fixes:ST-12")).toEqual([]);
    expect(closingKeysIn("fixes ST-123x")).toEqual([]);
  });
});

describe("branchNameFor", () => {
  test.each([
    ["ST-12", "Fix the login", "st-12-fix-the-login"],
    ["ST-12", "  Café: déjà vu!  ", "st-12-cafe-deja-vu"],
    ["SPI-3", "[ST-12] fix", "spi-3-st-12-fix"],
    ["ST-12", "Починить вход", "st-12"],
    ["ST-12", "", "st-12"],
    [
      "ST-12",
      "A very long title that goes on and on past forty characters",
      "st-12-a-very-long-title-that-goes-on-and-on-pa",
    ],
  ])("%s %s → %s", (key, title, branch) => {
    expect(branchNameFor(key, title)).toBe(branch);
  });

  test("the title part is at most 40 characters and ends without a dash", () => {
    const branch = branchNameFor("ST-1", "word ".repeat(30));
    expect(branch.length).toBeLessThanOrEqual("st-1-".length + 40);
    expect(branch).not.toEndWith("-");
    expect(taskKeyFromBranch(branch)).toBe("ST-1");
  });
});
