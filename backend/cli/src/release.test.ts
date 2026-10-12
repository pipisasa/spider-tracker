import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseChangelogDto, ReleaseCheckDto, ReleaseDto, RepoDto, TaskDto } from "@repo/core/contracts";
import { finishChangelog, withChangelog } from "@repo/core/release-notes";
import { run } from "./cli";
import type { GitRunner } from "./git";

// `spider release check | changelog | notes` (ST-95) against a fake API and a faked git log.

const status = { id: "done", name: "Done", category: "done" as const };
const releaseTask = (key: string, title: string) => ({
  id: `id-${key}`,
  key,
  title,
  projectKey: key.split("-")[0] ?? "",
  status,
  completedAt: "2026-10-10T00:00:00.000Z",
  shippedAt: null,
});
const task = (key: string, title: string): TaskDto => ({
  id: `id-${key}`,
  key,
  number: Number(key.split("-")[1]),
  projectId: "p",
  kind: "task",
  title,
  description: null,
  statusId: "done",
  priority: 0,
  parentId: null,
  parentKey: null,
  sortKey: "a0",
  startDate: null,
  targetDate: null,
  assigneeIds: [],
  tagIds: [],
  creatorId: "agent",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  completedAt: "2026-10-10T00:00:00.000Z",
  subtasks: null,
  releaseId: null,
  shippedAt: null,
  noCode: false,
  shipping: { state: "not_in_release", release: null },
  milestoneId: null,
  milestone: null,
});

function release(description: string | null = null): ReleaseDto {
  return {
    ...task("ST-120", "2026.10.13"),
    kind: "release",
    description,
    statusId: "planned",
    completedAt: null,
    shipping: null,
    status: { id: "planned", name: "Planned", category: "todo" },
    repos: [{ id: "r", fullName: "pipisasa/spider-tracker" }],
    apps: [
      { appId: "a-cli", repo: "pipisasa/spider-tracker", name: "cli", versioning: "semver", environments: [], version: "0.1.9" },
      { appId: "a-web", repo: "pipisasa/spider-tracker", name: "web", versioning: "date", environments: ["staging", "prod"], version: "2026.10.13" },
      { appId: "a-site", repo: "pipisasa/site", name: "site", versioning: "date", environments: [], version: "2026.10.13" },
    ],
    tasks: [releaseTask("ST-1", "Board columns"), releaseTask("ST-9", "Forgotten")],
  };
}

const app = (name: string, path: string, versioning: "date" | "semver") => ({
  id: `a-${name}`,
  repoId: "r",
  repo: "pipisasa/spider-tracker",
  name,
  path,
  sharedPaths: ["packages/core"],
  versioning,
  environments: [],
  createdAt: "2026-10-01T00:00:00.000Z",
});
const repo: RepoDto = {
  id: "r",
  owner: "pipisasa",
  name: "spider-tracker",
  fullName: "pipisasa/spider-tracker",
  defaultBranch: "main",
  githubInstallationId: null,
  projects: ["ST"],
  apps: [app("api", "backend/api", "date"), app("cli", "backend/cli", "semver"), app("web", "web/app", "date")],
  createdAt: "2026-10-01T00:00:00.000Z",
};

/** The server's changelog: two apps, so not grouped. */
const serverChangelog = (description: string | null = null): ReleaseChangelogDto =>
  finishChangelog(
    {
      release: { id: "id-ST-120", key: "ST-120", title: "2026.10.13" },
      apps: [
        { name: "cli", repo: "pipisasa/spider-tracker", version: "0.1.9", tag: "cli-v0.1.9" },
        { name: "web", repo: "pipisasa/spider-tracker", version: "2026.10.13", tag: "web-2026.10.13" },
        { name: "site", repo: "pipisasa/site", version: "2026.10.13", tag: "site-2026.10.13" },
      ],
      grouped: false,
      entries: [
        { key: "ST-1", title: "Board columns", projectKey: "ST", whatChanged: "- Release columns", handoff: null, apps: [] },
        { key: "ST-9", title: "Forgotten", projectKey: "ST", whatChanged: null, handoff: null, apps: [] },
      ],
    },
    description,
  );

function fakeApi(description: string | null = null) {
  const posts: { path: string; body: unknown }[] = [];
  const routes: Record<string, (body: unknown) => unknown> = {
    "GET /v1/whoami": () => ({
      actor: { id: "agent", type: "agent", name: "Bot", handle: "bot", avatarUrl: null, role: "member" },
      organization: { id: "o", slug: "acme", name: "Acme" },
    }),
    "GET /v1/orgs/acme/releases/ST-120": () => release(description),
    "GET /v1/orgs/acme/repos/pipisasa/spider-tracker": () => repo,
    "GET /v1/orgs/acme/projects": () => ({ items: [{ key: "ST" }, { key: "OPS" }] }),
    "GET /v1/orgs/acme/release-candidates": () => ({
      items: [task("ST-2", "Shared rule"), task("ST-5", "CLI flags"), task("ST-8", "Elsewhere")],
    }),
    "GET /v1/orgs/acme/releases/ST-120/changelog": () => serverChangelog(description),
    "POST /v1/orgs/acme/releases/ST-120/changelog": (body) => {
      const { taskApps } = body as { taskApps?: Record<string, string[]> };
      return { ...serverChangelog(), grouped: Boolean(taskApps), written: "added" };
    },
  };
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const key = `${init.method} ${url.pathname}`;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (init.method === "POST") posts.push({ path: url.pathname, body });
    const route = routes[key];
    return route ? Response.json(route(body)) : Response.json({ error: { code: "not_found", message: `No ${key}` } }, { status: 404 });
  };
  return { fetch, posts };
}

/** `git log` output in the format the CLI asks for. */
const log = (commits: { sha: string; parents?: string; subject: string; files?: string[] }[]) =>
  commits.map((c) => `\x1e${c.sha}\x1f${c.parents ?? "p1"}\x1f${c.subject}\x1f\x1f\n\n${(c.files ?? []).join("\n")}\n`).join("");

const commits = log([
  { sha: "1111111aaaa", subject: "feat(web): release columns (ST-1)", files: ["web/app/src/board.tsx"] },
  { sha: "2222222bbbb", subject: "feat(core): shared rule (ST-2)", files: ["packages/core/src/rule.ts"] },
  { sha: "5555555eeee", parents: "p1 p2", subject: "Merge branch 'st-5-cli-flags'" },
  { sha: "4444444dddd", subject: "feat(api): webhook (ST-4)", files: ["backend/api/src/hook.ts"] },
  { sha: "6666666ffff", subject: "fix: utf-8 handling", files: ["README.md"] },
]);

/** A clone of pipisasa/spider-tracker on main, with tags web-2026.10.01 and cli-v0.1.8. */
function fakeGit(root = "/work") {
  const calls: string[] = [];
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const git: GitRunner = (args) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd === "remote get-url origin") return ok("git@github.com:pipisasa/spider-tracker.git\n");
    if (cmd === "rev-parse --show-toplevel") return ok(`${root}\n`);
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const known = ["refs/heads/main^{commit}", "main^{commit}", "web-2026.10.01^{commit}", "cli-v0.1.7^{commit}", "cli-v0.1.8^{commit}"];
      return known.includes(args[3] ?? "") ? ok("abc\n") : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (cmd === "tag --list") return ok("cli-v0.1.7\ncli-v0.1.8\nweb-2026.10.01\n");
    if (cmd === "tag --list --merged main") return ok("cli-v0.1.7\ncli-v0.1.8\nweb-2026.10.01\n");
    if (args[0] === "log") return ok(commits);
    if (cmd === "diff --name-only 5555555eeee^1 5555555eeee") return ok("backend/cli/src/flags.ts\n");
    return { exitCode: 1, stdout: "", stderr: `unexpected git ${cmd}` };
  };
  return { git, calls };
}

async function spider(argv: string[], { description = null as string | null, git = fakeGit().git, cwd = "/work" } = {}) {
  const api = fakeApi(description);
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: { SPIDER_TOKEN: "spt_secret", SPIDER_API_URL: "https://api.test" },
    fetch: api.fetch,
    git,
    cwd,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { code, stdout, stderr, posts: api.posts };
}

describe("spider release check", () => {
  test("lists left-out candidates, included tasks without commits and changed apps outside the release; exit 1", async () => {
    const { git, calls } = fakeGit();
    const result = await spider(["release", "check", "ST-120", "--json"], { git });
    expect(result.code).toBe(1);
    const check = JSON.parse(result.stdout) as ReleaseCheckDto;
    expect(check.ok).toBe(false);
    expect(check.leftOut).toEqual([
      { key: "ST-2", title: "Shared rule", apps: ["cli", "web"], commits: ["2222222"] },
      { key: "ST-5", title: "CLI flags", apps: ["cli"], commits: ["5555555"] },
    ]);
    expect(check.noCommits).toEqual([{ key: "ST-9", title: "Forgotten" }]);
    expect(check.appsNotInRelease).toEqual([{ name: "api", since: null, commits: 2, tasks: ["ST-2", "ST-4"] }]);
    expect(check.skippedApps).toEqual([{ name: "site", repo: "pipisasa/site" }]);
    expect(check.apps.map((a) => [a.name, a.since, a.until, a.commits])).toEqual([
      ["api", null, "main", 2],
      ["cli", "cli-v0.1.8", "main", 2],
      ["web", "web-2026.10.01", "main", 2],
    ]);
    // One git log per range; the merge's files come from its diff.
    expect(calls.filter((c) => c.startsWith("log "))).toEqual([
      "log --no-color --format=%x1e%H%x1f%P%x1f%s%x1f%b%x1f --name-only main",
      "log --no-color --format=%x1e%H%x1f%P%x1f%s%x1f%b%x1f --name-only cli-v0.1.8..main",
      "log --no-color --format=%x1e%H%x1f%P%x1f%s%x1f%b%x1f --name-only web-2026.10.01..main",
    ]);
    expect(calls.filter((c) => c.startsWith("diff "))).toHaveLength(1);
  });

  test("human output; --since for never-tagged apps; outside a clone of the repo", async () => {
    const human = await spider(["release", "check", "ST-120"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("ST-120  2026.10.13  pipisasa/spider-tracker\n");
    expect(human.stdout).toContain("Left out (Done, in no release, with commits in the release's apps):\n  ST-2  Shared rule  (cli, web: 2222222)\n  ST-5  CLI flags  (cli: 5555555)\n");
    expect(human.stdout).toContain("Included, but no commits mention them:\n  ST-9  Forgotten\n");
    expect(human.stdout).toContain("Changed, but not in the release:\n  api  2 commits since the start (never tagged): ST-2, ST-4\n");
    expect(human.stdout).toContain("Not checked: site (pipisasa/site)");
    expect(human.stdout).toMatch(/4 findings\n$/);

    const since = await spider(["release", "check", "ST-120", "--since", "cli-v0.1.7", "--json"]);
    expect((JSON.parse(since.stdout) as ReleaseCheckDto).apps[0]).toMatchObject({ name: "api", since: "cli-v0.1.7" });
    expect((await spider(["release", "check", "ST-120", "--ref", "nope"])).code).toBe(2);

    const elsewhere: GitRunner = (args) =>
      args.join(" ") === "remote get-url origin" ? { exitCode: 0, stdout: "https://github.com/someone/else\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
    const outside = await spider(["release", "check", "ST-120"], { git: elsewhere });
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("This folder is a clone of someone/else, but ST-120 ships from pipisasa/spider-tracker, pipisasa/site");
  });
});

describe("spider release changelog", () => {
  test("groups the server's changelog by app from git; --write sends the apps per task", async () => {
    const read = await spider(["release", "changelog", "ST-120", "--json"]);
    expect(read.code).toBe(0);
    const changelog = JSON.parse(read.stdout) as ReleaseChangelogDto;
    expect(changelog.grouped).toBe(true);
    expect(changelog.entries.map((e) => [e.key, e.apps])).toEqual([
      ["ST-1", ["web"]],
      ["ST-9", []],
    ]);
    expect(changelog.markdown).toBe(
      "### cli 0.1.9\n\n_No tasks._\n\n### web 2026.10.13\n\n- **ST-1** Board columns\n  - Release columns\n\n### site 2026.10.13\n\n_No tasks._\n\n### Other changes\n\n- **ST-9** Forgotten",
    );
    expect(read.posts).toEqual([]);

    const human = await spider(["release", "changelog", "ST-120"]);
    expect(human.stdout.startsWith("### cli 0.1.9")).toBe(true);
    expect(human.stderr).toContain("Not in ST-120's description yet: run with --write to add it.");

    const written = await spider(["release", "changelog", "ST-120", "--write"]);
    expect(written.code).toBe(0);
    expect(written.posts).toEqual([{ path: "/v1/orgs/acme/releases/ST-120/changelog", body: { taskApps: { "ST-1": ["web"], "ST-9": [] } } }]);
    expect(written.stderr).toContain("Wrote the changelog to ST-120's description (added).");
  });

  test("--no-git keeps the server's grouping; outside the repo it says why; --force needs --write", async () => {
    const plain = await spider(["release", "changelog", "ST-120", "--no-git", "--json"], { git: () => ({ exitCode: 128, stdout: "", stderr: "" }) });
    expect(JSON.parse(plain.stdout)).toEqual(serverChangelog());
    const outside = await spider(["release", "changelog", "ST-120"], { git: () => ({ exitCode: 128, stdout: "", stderr: "" }) });
    expect(outside.code).toBe(0);
    expect(outside.stderr).toContain("Not grouped by app from git: This folder has no GitHub origin remote;");
    expect(outside.stdout.startsWith("### Changes")).toBe(true);
    expect((await spider(["release", "changelog", "ST-120", "--force"])).code).toBe(2);
  });
});

describe("spider release notes", () => {
  const block = "### cli 0.1.9\n\n- **ST-5** CLI flags (edited by hand)\n\n### web 2026.10.13\n\n- **ST-1** Board columns";
  const description = withChangelog("Intro.", block);

  test("one app's section of the description's changelog, with its tag", async () => {
    const result = await spider(["release", "notes", "ST-120", "--app", "cli", "--json"], { description });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      release: { key: "ST-120", title: "2026.10.13" },
      app: "cli",
      tag: "cli-v0.1.9",
      source: "description",
      markdown: "- **ST-5** CLI flags (edited by hand)",
      appended: null,
    });
    expect((await spider(["release", "notes", "ST-120", "--app", "api"], { description })).code).toBe(2);
  });

  test("--append adds the release to CHANGELOG.md at the repository root, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "spider-notes-"));
    try {
      const file = join(root, "CHANGELOG.md");
      writeFileSync(file, "# Changelog\n\n## Unreleased\n\n- next\n\n## Older\n");
      const first = await spider(["release", "notes", "ST-120", "--append"], { description, git: fakeGit(root).git, cwd: join(root, "sub") });
      expect(first.code).toBe(0);
      expect(first.stderr).toContain(`Added ST-120 to ${file}`);
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/^# Changelog\n\n## Unreleased\n\n- next\n\n## 2026\.10\.13 \(ST-120, \d{4}-\d{2}-\d{2}\)\n<!-- spider:release ST-120 -->\n\n### cli 0\.1\.9\n/);
      expect(text.endsWith("- **ST-1** Board columns\n\n## Older\n")).toBe(true);
      const again = await spider(["release", "notes", "ST-120", "--append", "--json"], { description, git: fakeGit(root).git, cwd: root });
      expect(JSON.parse(again.stdout)).toMatchObject({ appended: { path: file, inserted: false } });
      expect(readFileSync(file, "utf8")).toBe(text);
      expect((await spider(["release", "notes", "ST-120", "--append", "--app", "cli"], { description })).code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without a changelog in the description, generates one", async () => {
    const result = await spider(["release", "notes", "ST-120", "--app", "web"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("- **ST-1** Board columns\n  - Release columns\n");
    expect(result.stderr).toContain("ST-120's description has no changelog yet");
  });
});
