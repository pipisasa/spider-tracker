import { describe, expect, test } from "bun:test";
import { parseRepoRemote } from "./remotes";
import {
  branchNameSchema,
  createAppInput,
  createRepoInput,
  repoPathSchema,
  updateAppInput,
} from "./schemas";

describe("parseRepoRemote (ST-92)", () => {
  test.each([
    "pipisasa/spider-tracker",
    "https://github.com/pipisasa/spider-tracker",
    "https://github.com/pipisasa/spider-tracker.git",
    "https://github.com/pipisasa/spider-tracker/",
    "http://www.github.com/pipisasa/spider-tracker",
    "https://user@github.com/pipisasa/spider-tracker.git",
    "git@github.com:pipisasa/spider-tracker.git",
    "git@github.com:pipisasa/spider-tracker",
    "github.com:pipisasa/spider-tracker.git",
    "ssh://git@github.com/pipisasa/spider-tracker.git",
    "ssh://git@github.com:22/pipisasa/spider-tracker.git",
    "git://github.com/pipisasa/spider-tracker.git",
    "git+ssh://git@github.com/pipisasa/spider-tracker.git",
    "github.com/pipisasa/spider-tracker",
    "  GitHub.com/pipisasa/spider-tracker  ",
  ])("%s", (url) => {
    expect(parseRepoRemote(url)).toEqual({
      owner: "pipisasa",
      name: "spider-tracker",
    });
  });

  test("keeps the casing and dots in names", () => {
    expect(parseRepoRemote("https://github.com/Batele/My.Repo_2.git")).toEqual({
      owner: "Batele",
      name: "My.Repo_2",
    });
  });

  test.each([
    "",
    "spider-tracker",
    "a/b/c",
    "https://github.com/pipisasa",
    "https://github.com/pipisasa/spider-tracker/tree/main",
    "https://gitlab.com/pipisasa/spider-tracker.git",
    "git@bitbucket.org:pipisasa/spider-tracker.git",
    "-bad/name",
    "owner/..",
    "owner/na me",
    "https://github.com/owner/na%20me",
    "not a url",
  ])("refuses %p", (url) => {
    expect(parseRepoRemote(url)).toBeNull();
  });
});

describe("repo and app input", () => {
  test("a repo is added by URL, with an optional default branch and projects", () => {
    expect(
      createRepoInput.parse({
        url: "git@github.com:pipisasa/spider-tracker.git",
        projects: ["st"],
      }),
    ).toEqual({
      url: { owner: "pipisasa", name: "spider-tracker" },
      projects: ["ST"],
    });
    expect(
      createRepoInput.safeParse({ url: "https://gitlab.com/a/b" }).success,
    ).toBe(false);
  });

  test("branch names", () => {
    for (const ok of ["main", "release/2026.10", "dev_1"])
      expect(branchNameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", "-x", "a..b", "a//b", "x/", "x.lock", "a b"])
      expect(branchNameSchema.safeParse(bad).success).toBe(false);
  });

  test("paths are relative folders, normalized", () => {
    expect(repoPathSchema.parse("./web/app/")).toBe("web/app");
    expect(repoPathSchema.parse(".")).toBe(".");
    expect(repoPathSchema.parse("./")).toBe(".");
    expect(repoPathSchema.parse("packages/@scope/core")).toBe(
      "packages/@scope/core",
    );
    for (const bad of ["", "/abs", "../up", "a/../b", "a//b", "a\\b"]) {
      expect(repoPathSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("apps: lower-case names, unique environments and shared paths", () => {
    expect(
      createAppInput.parse({
        name: "Web",
        path: "web/app",
        environments: ["staging", "prod"],
      }),
    ).toEqual({
      name: "web",
      path: "web/app",
      environments: ["staging", "prod"],
    });
    expect(
      createAppInput.safeParse({
        name: "api",
        path: "backend/api",
        environments: ["prod", "prod"],
      }).success,
    ).toBe(false);
    expect(
      createAppInput.safeParse({
        name: "api",
        path: "x",
        sharedPaths: ["packages/core", "./packages/core"],
      }).success,
    ).toBe(false);
    expect(
      createAppInput.safeParse({ name: "api", path: "x", versioning: "calver" })
        .success,
    ).toBe(false);
    expect(updateAppInput.safeParse({}).success).toBe(false);
    expect(updateAppInput.parse({ environments: [] })).toEqual({
      environments: [],
    });
  });
});
