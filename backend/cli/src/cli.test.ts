import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunOptions } from "./cli";
import type { Store } from "./credentials";
import type { GitRunner } from "./git";
import { CLI_VERSION } from "./version";

const project = {
  id: "p",
  key: "ST",
  name: "Spider",
  description: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  statuses: [
    { id: "s1", name: "Todo", category: "todo", color: null, position: 1 },
  ],
};
const task = {
  id: "t",
  key: "ST-1",
  number: 1,
  projectId: "p",
  title: "Write the CLI",
  description: null,
  statusId: "s1",
  priority: 0,
  parentId: null,
  parentKey: null,
  sortKey: "a0",
  assigneeIds: [],
  tagIds: [],
  creatorId: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
};

/** A tiny fake API: answers known paths and records what was requested. */
function fakeApi(overrides: Record<string, () => Response> = {}) {
  const requests: { url: string; headers: Headers }[] = [];
  const routes: Record<string, () => Response> = {
    "GET /v1/whoami": () =>
      Response.json({
        actor: {
          id: "agent",
          type: "agent",
          name: "Bot",
          handle: "bot",
          avatarUrl: null,
          role: "member",
        },
        organization: { id: "o", slug: "acme", name: "Acme" },
      }),
    "GET /v1/orgs/acme/members": () => Response.json({ items: [] }),
    "GET /v1/orgs/acme/projects/ST": () => Response.json(project),
    "GET /v1/orgs/acme/tasks/ST-1": () => Response.json(task),
    ...overrides,
  };
  const fetch = (input: string, init: RequestInit) => {
    const url = new URL(input);
    requests.push({ url: input, headers: new Headers(init.headers) });
    const route = routes[`${init.method} ${url.pathname}`];
    return route
      ? route()
      : Response.json(
          { error: { code: "not_found", message: "Task not found" } },
          { status: 404 },
        );
  };
  return { fetch, requests };
}

/** The default git for `cli()`: tests that need git inject a fake, so none runs real git in the runner's directory. */
const noGit: GitRunner = (args) => {
  throw new Error(
    `test ran git ${args.join(" ")} without injecting a fake git`,
  );
};

/** A git runner for a directory that is not a repository. */
const notARepo: GitRunner = () => ({
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository",
});

async function cli(argv: string[], options: Partial<RunOptions> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: { SPIDER_TOKEN: "spt_secret", SPIDER_API_URL: "https://api.test" },
    fetch: fakeApi().fetch,
    git: noGit,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    ...options,
  });
  return { code, stdout, stderr };
}

describe("exit codes", () => {
  test("0 with compact output, stable JSON with --json", async () => {
    const human = await cli(["task", "view", "st-1"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toStartWith("ST-1  Write the CLI\nStatus: Todo");

    const json = await cli(["task", "view", "ST-1", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      key: "ST-1",
      status: { id: "s1", name: "Todo", category: "todo" },
      assignees: [],
    });
  });

  test("sends the token, the cli source, and never prints the token", async () => {
    const api = fakeApi();
    const result = await cli(["whoami"], { fetch: api.fetch });
    expect(result.stdout).toBe("@bot (Bot, member) in acme\n");
    expect(api.requests[0]?.url).toBe("https://api.test/v1/whoami");
    expect(api.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer spt_secret",
    );
    expect(api.requests[0]?.headers.get("X-Spider-Source")).toBe("cli");
    expect(result.stdout + result.stderr).not.toContain("spt_secret");
  });

  test("2 for usage and validation errors", async () => {
    expect((await cli(["task", "frobnicate"])).code).toBe(2);
    expect((await cli(["task", "create", "--title", "No project"])).code).toBe(
      2,
    );
    expect((await cli(["task", "view", "not a key"])).code).toBe(2);
    expect(
      (await cli(["task", "update", "ST-1", "--priority", "9"])).stderr,
    ).toContain("Invalid priority");
    expect((await cli(["task", "update", "ST-1"])).stderr).toBe(
      "spider: Nothing to update. Pass --title, --status, --assign, …\n",
    );
    expect(
      (await cli(["task", "update", "ST-1", "--status", "Shipped"])).code,
    ).toBe(2);
    expect((await cli(["task", "start", "ST-1"])).stderr).toContain(
      'ST has no "in_progress" status',
    );
  });

  test("2 when the key is omitted and the branch has none", async () => {
    const result = await cli(["task", "view"], { git: notARepo, cwd: "/work" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No task key given");
  });

  test("mcp-headers prints the Authorization header for Claude Code", async () => {
    const result = await cli(["mcp-headers"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      Authorization: "Bearer spt_secret",
    });
  });

  test("parse errors are JSON on stderr under --json", async () => {
    const result = await cli(["task", "list", "--json", "--bogus"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "usage", message: "unknown option '--bogus'" },
    });
  });

  test("3 when the task is missing, with a JSON error on stderr under --json", async () => {
    const result = await cli(["task", "view", "ST-9", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "not_found", message: "Task not found" },
    });
  });

  test("4 without a token or when the API refuses it", async () => {
    const missing = await cli(["whoami"], { env: {} });
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain("Not signed in");

    const refused = fakeApi({
      "GET /v1/whoami": () =>
        Response.json(
          {
            error: {
              code: "unauthorized",
              message: "Invalid or revoked API key",
            },
          },
          { status: 401 },
        ),
    });
    expect((await cli(["whoami"], { fetch: refused.fetch })).code).toBe(4);
  });

  test("1 for unexpected failures", async () => {
    const down = () => {
      throw new TypeError("Unable to connect");
    };
    const result = await cli(["whoami"], { fetch: down });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("spider: Unable to connect\n");
  });

  test("an error response without a JSON body still prints a message (ST-107)", async () => {
    // A proxy's HTML page over HTTP/2, which has no status text.
    const proxy = fakeApi({
      "GET /v1/whoami": () =>
        new Response("<html>Bad gateway</html>", { status: 502 }),
    });
    const result = await cli(["whoami"], { fetch: proxy.fetch });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("spider: GET /v1/whoami failed with HTTP 502\n");
    const json = await cli(["whoami", "--json"], { fetch: proxy.fetch });
    expect(JSON.parse(json.stderr)).toEqual({
      error: {
        code: "unknown",
        message: "GET /v1/whoami failed with HTTP 502",
      },
    });
  });

  test("--help and --version exit 0 without a token", async () => {
    const help = await cli(["task", "--help"], { env: {} });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("start [options] [key]");
    expect((await cli(["--version"], { env: {} })).stdout).toBe(
      `${CLI_VERSION}\n`,
    );
  });

  test("doc create and doc edit help describe the [[link]] syntax (ST-115)", async () => {
    for (const command of ["create", "edit"]) {
      const help = await cli(["doc", command, "--help"], { env: {} });
      expect(help.code).toBe(0);
      for (const syntax of [
        "[[Title]]",
        "[[Title|label]]",
        "[[doc:<id>]]",
        "[[ST-12]]",
      ])
        expect(help.stdout).toContain(syntax);
    }
  });

  test("the help subcommand exits 0, but a bare command group is a usage error", async () => {
    expect((await cli(["help"], { env: {} })).code).toBe(0);
    const taskHelp = await cli(["help", "task"], { env: {} });
    expect(taskHelp.code).toBe(0);
    expect(taskHelp.stdout).toContain("start [options] [key]");
    expect((await cli(["task", "help"], { env: {} })).code).toBe(0);
    expect((await cli(["task"], { env: {} })).code).toBe(2);
  });
});

/** Two saved agents on prod (reviewer is the default) and one on local, in a temp config dir and home. */
function savedAgents() {
  const home = mkdtempSync(join(tmpdir(), "spider-home-"));
  const configDir = join(home, "config");
  mkdirSync(configDir);
  const saved = (handle: string, token: string) => ({
    token,
    actor: { name: handle, handle },
    projects: handle === "reviewer" ? [{ key: "ST", name: "Spider" }] : null,
    source: "invite" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const store: Store = {
    version: 2,
    default: { server: "prod", org: "acme", agent: "reviewer" },
    servers: {
      prod: {
        url: "https://api.test",
        orgs: {
          acme: {
            name: "Acme",
            agents: {
              reviewer: saved("reviewer", "spt_rev"),
              writer: saved("writer", "spt_wri"),
            },
          },
        },
      },
      local: {
        url: "http://localhost:4000",
        orgs: {
          acme: {
            name: "Acme",
            agents: { writer: saved("writer", "spt_local") },
          },
        },
      },
    },
  };
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify(store), {
    mode: 0o600,
  });
  const env = { HOME: home, SPIDER_CONFIG_DIR: configDir };
  return {
    home,
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A fake git repository: records commands and answers the ones `spider start` runs. */
function fakeGit({
  repo = true,
  branch = "main",
  branches = ["main"],
  remote = [] as string[],
  dirty = false,
  failSwitch = false,
} = {}) {
  const state = { branch, branches: new Set(branches) };
  const calls: string[] = [];
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const fail = (stderr = "") => ({ exitCode: 128, stdout: "", stderr });
  const git: GitRunner = (args, cwd) => {
    expect(cwd).toBe("/work");
    calls.push(args.join(" "));
    if (!repo) return fail("fatal: not a git repository");
    const [command, ...rest] = args;
    if (command === "rev-parse" && rest[0] === "--is-inside-work-tree")
      return ok("true\n");
    if (command === "rev-parse") {
      const ref = rest.at(-1) ?? "";
      const found = ref.startsWith("refs/remotes/origin/")
        ? remote.includes(ref.slice("refs/remotes/origin/".length))
        : state.branches.has(ref.replace("refs/heads/", ""));
      return found ? ok() : fail();
    }
    if (command === "branch") return ok(`${state.branch}\n`);
    if (command === "status") return ok(dirty ? " M src/index.ts\n" : "");
    if (command === "switch") {
      if (failSwitch)
        return fail(
          "error: Your local changes would be overwritten by checkout",
        );
      const name = rest[0] === "-c" ? (rest[1] ?? "") : (rest[0] ?? "");
      if (rest[0] === "-c") state.branches.add(name);
      state.branch = name;
      return ok();
    }
    return fail(`unexpected git ${args.join(" ")}`);
  };
  return { git, calls, state };
}

describe("spider start", () => {
  const startApi = () => {
    const statuses = [
      ...project.statuses,
      {
        id: "s2",
        name: "Doing",
        category: "in_progress",
        color: null,
        position: 2,
      },
    ];
    return fakeApi({
      "GET /v1/orgs/acme/projects/ST": () =>
        Response.json({ ...project, statuses }),
      "PATCH /v1/orgs/acme/tasks/ST-1": () =>
        Response.json({ ...task, statusId: "s2", assigneeIds: ["agent"] }),
    }).fetch;
  };
  const start = (argv: string[], git: GitRunner) =>
    cli(argv, { fetch: startApi(), git, cwd: "/work" });

  test("on main it creates and switches to st-1-<title>", async () => {
    const { git, calls, state } = fakeGit();
    const result = await start(["task", "start", "ST-1"], git);
    expect(result.code).toBe(0);
    expect(state.branch).toBe("st-1-write-the-cli");
    expect(calls).toContain("switch -c st-1-write-the-cli");
    expect(result.stdout).toContain(
      "Git: switched /work from main to new branch st-1-write-the-cli (--no-branch leaves git alone)",
    );
    expect(result.stderr).toBe("");
  });

  test("a branch only on origin is tracked, not created from HEAD", async () => {
    const { git, calls, state } = fakeGit({ remote: ["st-1-write-the-cli"] });
    const result = await start(["start", "ST-1"], git);
    expect(result.code).toBe(0);
    expect(calls).toContain(
      "switch -c st-1-write-the-cli --track origin/st-1-write-the-cli",
    );
    expect(state.branch).toBe("st-1-write-the-cli");
    expect(result.stdout).toContain(
      "from main to new branch st-1-write-the-cli tracking origin/st-1-write-the-cli",
    );
  });

  test("an existing branch is switched to, not created; --json has the branch", async () => {
    const { git, calls } = fakeGit({
      branches: ["main", "st-1-write-the-cli"],
    });
    const result = await start(["start", "ST-1", "--json"], git);
    expect(result.code).toBe(0);
    expect(calls).toContain("switch st-1-write-the-cli");
    expect(JSON.parse(result.stdout)).toMatchObject({
      key: "ST-1",
      status: { category: "in_progress" },
      branch: "st-1-write-the-cli",
    });
  });

  test("already on a branch with the key: no switch, the key comes from the branch", async () => {
    const { git, calls } = fakeGit({
      branch: "feat/st-1-cli",
      branches: ["main", "feat/st-1-cli"],
    });
    const result = await start(["start", "--json"], git);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      key: "ST-1",
      branch: "feat/st-1-cli",
    });
    expect(calls.some((c) => c.startsWith("switch"))).toBe(false);
  });

  test("--no-branch leaves git alone", async () => {
    const { git, calls } = fakeGit();
    const result = await start(
      ["task", "start", "ST-1", "--no-branch", "--json"],
      git,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      key: "ST-1",
      branch: null,
    });
    expect(calls).toEqual([]);
  });

  test("outside a repository the branch is skipped", async () => {
    const { git, calls } = fakeGit({ repo: false });
    const result = await start(["start", "ST-1", "--json"], git);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ branch: null });
    expect(calls).toEqual(["rev-parse --is-inside-work-tree"]);
  });

  test("a dirty working tree warns but still switches", async () => {
    const { git, state } = fakeGit({ dirty: true });
    const result = await start(["start", "ST-1"], git);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("uncommitted changes");
    expect(state.branch).toBe("st-1-write-the-cli");
  });

  test("a failed switch warns; the task is still started", async () => {
    const { git, state } = fakeGit({
      branches: ["main", "st-1-write-the-cli"],
      failSwitch: true,
    });
    const result = await start(["start", "ST-1", "--json"], git);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "couldn't switch to branch st-1-write-the-cli: error: Your local changes",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: { category: "in_progress" },
      branch: null,
    });
    expect(state.branch).toBe("main");
  });
});

describe("spider pr (ST-87)", () => {
  const opened = {
    taskKey: "ST-1",
    pullRequest: {
      repo: "acme/app",
      number: 7,
      title: "Write the CLI (ST-1)",
      url: "https://github.com/acme/app/pull/7",
      state: "open",
      draft: false,
      headBranch: "st-1-write-the-cli",
      baseBranch: "main",
      author: "spider-tracker[bot]",
      mergedAt: null,
      closedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      via: "closing",
    },
  };

  /**
   * git for `spider pr`: a repo on `branch` with an origin remote whose default branch is
   * `originHead` (unknown when null); push succeeds unless `failPush`.
   */
  function prGit({
    repo = true,
    branch = "st-1-write-the-cli",
    origin = "git@github.com:acme/app.git" as string | null,
    originHead = null as string | null,
    failPush = false,
  } = {}) {
    const calls: string[] = [];
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (stderr = "") => ({ exitCode: 128, stdout: "", stderr });
    const git: GitRunner = (args, cwd) => {
      expect(cwd).toBe("/work");
      calls.push(args.join(" "));
      if (!repo) return fail("fatal: not a git repository");
      const command = args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") return ok("true\n");
      if (command === "branch --show-current")
        return ok(branch ? `${branch}\n` : "");
      if (command === "remote get-url origin")
        return origin
          ? ok(`${origin}\n`)
          : fail("error: No such remote 'origin'");
      if (command === "symbolic-ref refs/remotes/origin/HEAD") {
        return originHead
          ? ok(`refs/remotes/origin/${originHead}\n`)
          : fail("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref");
      }
      if (args[0] === "push")
        return failPush ? fail("fatal: Authentication failed") : ok();
      return fail(`unexpected git ${command}`);
    };
    return { git, calls };
  }

  /** The API: records the pull-request body; answers `respond`. */
  function prApi(
    respond: () => Response = () => Response.json(opened, { status: 201 }),
  ) {
    const bodies: unknown[] = [];
    const api = fakeApi();
    const fetch = (input: string, init: RequestInit) => {
      if (
        init.method === "POST" &&
        new URL(input).pathname === "/v1/orgs/acme/tasks/ST-1/pull-request"
      ) {
        bodies.push(JSON.parse(String(init.body)));
        return respond();
      }
      return api.fetch(input, init);
    };
    return { fetch, bodies };
  }

  test("pushes the current branch with git, then opens the PR for the branch's task", async () => {
    const { git, calls } = prGit();
    const api = prApi();
    const result = await cli(["pr"], { git, fetch: api.fetch, cwd: "/work" });
    expect(result.code).toBe(0);
    expect(calls).toContain("push --set-upstream origin st-1-write-the-cli");
    expect(api.bodies).toEqual([
      { repo: "acme/app", head: "st-1-write-the-cli" },
    ]);
    expect(result.stdout).toBe(
      "Pushed st-1-write-the-cli to origin\nOpened acme/app#7 for ST-1: Write the CLI (ST-1)  (st-1-write-the-cli → main)\nhttps://github.com/acme/app/pull/7\n",
    );
  });

  test("--json is the API's answer (as MCP open_pull_request); --draft, --base and --no-push", async () => {
    const { git, calls } = prGit({ branch: "feature-x" });
    const api = prApi();
    const result = await cli(
      ["pr", "ST-1", "--draft", "--base", "develop", "--no-push", "--json"],
      { git, fetch: api.fetch, cwd: "/work" },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(opened);
    expect(calls.some((c) => c.startsWith("push"))).toBe(false);
    expect(api.bodies).toEqual([
      { repo: "acme/app", head: "feature-x", base: "develop", draft: true },
    ]);
  });

  test("outside a repository: --no-push lets the API pick the task's branch; without it, a usage error", async () => {
    const api = prApi();
    const noPush = await cli(
      [
        "task",
        "pr",
        "ST-1",
        "--no-push",
        "--repo",
        "https://github.com/acme/app",
      ],
      {
        git: prGit({ repo: false }).git,
        fetch: api.fetch,
        cwd: "/work",
      },
    );
    expect(noPush.code).toBe(0);
    expect(api.bodies).toEqual([{ repo: "acme/app" }]);

    const pushing = await cli(["pr", "ST-1"], {
      git: prGit({ repo: false }).git,
      fetch: api.fetch,
      cwd: "/work",
    });
    expect(pushing.code).toBe(2);
    expect(pushing.stderr).toContain("Not in a git repository");
    expect(
      (
        await cli(["pr", "ST-1"], {
          git: prGit({ branch: "" }).git,
          fetch: api.fetch,
          cwd: "/work",
        })
      ).stderr,
    ).toContain("detached HEAD");
    expect(
      (
        await cli(["pr", "ST-1", "--repo", "not a repo"], {
          git: prGit().git,
          fetch: api.fetch,
          cwd: "/work",
        })
      ).code,
    ).toBe(2);
  });

  test("a failed push stops before the API; no origin remote is a usage error", async () => {
    const api = prApi();
    const failed = await cli(["pr"], {
      git: prGit({ failPush: true }).git,
      fetch: api.fetch,
      cwd: "/work",
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe(
      "spider: git push failed: fatal: Authentication failed\n",
    );
    const noOrigin = await cli(["pr"], {
      git: prGit({ origin: null }).git,
      fetch: api.fetch,
      cwd: "/work",
    });
    expect(noOrigin.code).toBe(2);
    expect(noOrigin.stderr).toContain("no origin remote");
    expect(api.bodies).toEqual([]);
  });

  test("never pushes the origin's default branch, the base, main or master, whatever --any-branch says (ST-144, ST-146)", async () => {
    const api = prApi();
    const pushed = (calls: string[]) => calls.some((c) => c.startsWith("push"));
    for (const [options, argv] of [
      [
        { branch: "trunk", originHead: "trunk" },
        ["pr", "ST-1", "--any-branch"],
      ],
      [{ branch: "main" }, ["pr", "ST-1"]],
      [{ branch: "master" }, ["pr", "ST-1", "--any-branch"]],
      [
        { branch: "st-1-write-the-cli" },
        ["pr", "--base", "st-1-write-the-cli"],
      ],
    ] as const) {
      const { git, calls } = prGit(options);
      const result = await cli([...argv], {
        git,
        fetch: api.fetch,
        cwd: "/work",
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`Not pushing ${options.branch}`);
      expect(pushed(calls)).toBe(false);
    }
    // A known default other than main: main and master are still never pushed (ST-146).
    for (const branch of ["main", "master"]) {
      const { git, calls } = prGit({ branch, originHead: "trunk" });
      const result = await cli(["pr", "ST-1", "--any-branch"], {
        git,
        fetch: api.fetch,
        cwd: "/work",
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        `Not pushing ${branch}: it is main or master, which spider pr never pushes`,
      );
      expect(pushed(calls)).toBe(false);
    }
    expect(api.bodies).toEqual([]);
  });

  test("pushes only the task's own branch, unless --any-branch (ST-144)", async () => {
    const api = prApi();
    const other = prGit({ branch: "st-2-something-else" });
    const refused = await cli(["pr", "ST-1"], {
      git: other.git,
      fetch: api.fetch,
      cwd: "/work",
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      "Not pushing st-2-something-else: it isn't a branch of ST-1",
    );
    expect(other.calls.some((c) => c.startsWith("push"))).toBe(false);
    const plain = prGit({ branch: "feature-x" });
    expect(
      (
        await cli(["pr", "ST-1"], {
          git: plain.git,
          fetch: api.fetch,
          cwd: "/work",
        })
      ).code,
    ).toBe(2);
    expect(api.bodies).toEqual([]);

    const anyBranch = prGit({ branch: "feature-x", originHead: "main" });
    expect(
      (
        await cli(["pr", "ST-1", "--any-branch"], {
          git: anyBranch.git,
          fetch: api.fetch,
          cwd: "/work",
        })
      ).code,
    ).toBe(0);
    expect(anyBranch.calls).toContain("push --set-upstream origin feature-x");
    // The key is matched case-insensitively, as the branch's task.
    const upper = prGit({ branch: "ST-1-Write" });
    expect(
      (
        await cli(["pr", "st-1"], {
          git: upper.git,
          fetch: api.fetch,
          cwd: "/work",
        })
      ).code,
    ).toBe(0);
    expect(upper.calls).toContain("push --set-upstream origin ST-1-Write");
  });

  test("a PR already open: exit 2 with its URL, in --json as error.url", async () => {
    const url = "https://github.com/acme/app/pull/3";
    const api = prApi(() =>
      Response.json(
        {
          error: {
            code: "conflict",
            message: `A pull request is already open for st-1-write-the-cli: ${url}`,
            url,
          },
        },
        { status: 409 },
      ),
    );
    const human = await cli(["pr", "--no-push"], {
      git: prGit().git,
      fetch: api.fetch,
      cwd: "/work",
    });
    expect(human.code).toBe(2);
    expect(human.stderr).toBe(
      `spider: A pull request is already open for st-1-write-the-cli: ${url}\n`,
    );
    const json = await cli(["pr", "--no-push", "--json"], {
      git: prGit().git,
      fetch: api.fetch,
      cwd: "/work",
    });
    expect(JSON.parse(json.stderr)).toEqual({
      error: {
        code: "conflict",
        message: `A pull request is already open for st-1-write-the-cli: ${url}`,
        url,
      },
    });
  });
});

describe("saved agents", () => {
  test("which key: --as > SPIDER_TOKEN > SPIDER_AGENT > default", async () => {
    const { env, cleanup } = savedAgents();
    const token = async (
      argv: string[],
      extra: Record<string, string> = {},
    ) => {
      const result = await cli(argv, { env: { ...env, ...extra } });
      return result.code === 0
        ? (JSON.parse(result.stdout) as { Authorization: string }).Authorization
        : result.stderr;
    };
    try {
      expect(await token(["mcp-headers"])).toBe("Bearer spt_rev");
      expect(
        await token(["mcp-headers"], { SPIDER_AGENT: "prod/acme/writer" }),
      ).toBe("Bearer spt_wri");
      expect(
        await token(["mcp-headers"], {
          SPIDER_AGENT: "local/acme/writer",
          SPIDER_TOKEN: "spt_env",
        }),
      ).toBe("Bearer spt_env");
      expect(
        await token(["mcp-headers", "--as", "local/acme/writer"], {
          SPIDER_TOKEN: "spt_env",
        }),
      ).toBe("Bearer spt_local");
      expect(
        await token(["--as", "reviewer", "mcp-headers"], {
          SPIDER_AGENT: "prod/acme/writer",
        }),
      ).toBe("Bearer spt_rev");
      const ambiguous = await cli(["mcp-headers", "--as", "writer"], { env });
      expect(ambiguous.code).toBe(2);
      expect(ambiguous.stderr).toContain("prod/acme/writer, local/acme/writer");
    } finally {
      cleanup();
    }
  });

  test("not found as an agent limited to some projects names the agent and its projects (ST-107)", async () => {
    const { env, cleanup } = savedAgents();
    try {
      // The default agent sees only ST, so ANT-49 reads as missing: say who acted.
      const scoped = await cli(
        ["task", "update", "ANT-49", "--status", "Todo", "--priority", "1"],
        { env },
      );
      expect(scoped.code).toBe(3);
      expect(scoped.stderr).toBe(
        "spider: Task not found (acting as prod/acme/reviewer, the default agent, which sees only ST; pass --as <agent> to act as another)\n",
      );
      const json = await cli(
        ["task", "update", "ANT-49", "--status", "Todo", "--json"],
        { env: { ...env, SPIDER_AGENT: "reviewer" } },
      );
      expect(JSON.parse(json.stderr)).toEqual({
        error: {
          code: "not_found",
          message:
            "Task not found (acting as prod/acme/reviewer, named by SPIDER_AGENT, which sees only ST; pass --as <agent> to act as another)",
        },
      });
      // An agent that sees every project gets the plain message.
      const unscoped = await cli(
        ["task", "view", "ANT-49", "--as", "prod/acme/writer"],
        { env },
      );
      expect(unscoped).toMatchObject({
        code: 3,
        stderr: "spider: Task not found\n",
      });
    } finally {
      cleanup();
    }
  });

  test("mcp-headers --server only gives a key for that server", async () => {
    const { env, cleanup } = savedAgents();
    const headers = async (
      argv: string[],
      extra: Record<string, string> = {},
    ) => {
      const result = await cli(argv, { env: { ...env, ...extra } });
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout) as Record<string, string>;
    };
    try {
      // The default (prod/acme/reviewer) is on prod.
      expect(await headers(["mcp-headers", "--server", "prod"])).toEqual({
        Authorization: "Bearer spt_rev",
      });
      expect(
        await headers(["mcp-headers", "--server", "https://api.test"]),
      ).toEqual({ Authorization: "Bearer spt_rev" });
      expect(await headers(["mcp-headers", "--server", "local"])).toEqual({});
      // A local agent in use (spider claude local/…, or a local default) sends nothing to prod.
      expect(
        await headers(["mcp-headers", "--server", "prod"], {
          SPIDER_AGENT: "local/acme/writer",
        }),
      ).toEqual({});
      expect(
        await headers([
          "mcp-headers",
          "--server",
          "prod",
          "--as",
          "local/acme/writer",
        ]),
      ).toEqual({});
      expect(
        await headers(["mcp-headers", "--server", "local"], {
          SPIDER_AGENT: "local/acme/writer",
        }),
      ).toEqual({
        Authorization: "Bearer spt_local",
      });
      expect(
        (await cli(["agents", "default", "local/acme/writer"], { env })).code,
      ).toBe(0);
      const none = await cli(["mcp-headers", "--server", "prod"], { env });
      expect(none.stdout).toBe("{}\n");
      expect(none.stdout + none.stderr).not.toContain("spt_");
      // Without --server, the default is still used, wherever it is.
      expect(await headers(["mcp-headers"])).toEqual({
        Authorization: "Bearer spt_local",
      });
      // SPIDER_TOKEN only when SPIDER_API_URL is that server (unset = prod).
      expect(
        await headers(["mcp-headers", "--server", "prod"], {
          SPIDER_TOKEN: "spt_env",
        }),
      ).toEqual({
        Authorization: "Bearer spt_env",
      });
      expect(
        await headers(["mcp-headers", "--server", "prod"], {
          SPIDER_TOKEN: "spt_env",
          SPIDER_API_URL: "http://localhost:4000",
        }),
      ).toEqual({});
      expect(
        await headers(["mcp-headers", "--server", "local"], {
          SPIDER_TOKEN: "spt_env",
          SPIDER_API_URL: "http://localhost:4000/",
        }),
      ).toEqual({ Authorization: "Bearer spt_env" });
    } finally {
      cleanup();
    }
  });

  test("mcp-headers --server with nothing saved prints no headers", async () => {
    const home = mkdtempSync(join(tmpdir(), "spider-home-"));
    try {
      const result = await cli(["mcp-headers", "--server", "prod"], {
        env: { HOME: home, SPIDER_CONFIG_DIR: join(home, "config") },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("{}\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unusable credentials file is an error and is left as it is", async () => {
    const { env, cleanup } = savedAgents();
    const path = join(env.SPIDER_CONFIG_DIR, "credentials.json");
    try {
      for (const content of [
        '{"version": 2, "servers": {"prod": {"url": "x", "orgs": {"acme": {"name": "A", "agents": {"bot": {"token": "spt_corrupt"',
        '{"version": 3, "servers": {}}',
        '{"version": 2, "servers": {"prod": {"orgs": {}}}}',
        "[]",
      ]) {
        writeFileSync(path, content);
        const result = await cli(["agents", "default", "prod/acme/reviewer"], {
          env,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(path);
        expect(result.stderr).toContain("Fix the file or move it away");
        expect(result.stderr).not.toContain("spt_");
        const login = await cli(
          ["accept-invite", "ABCD-EFGH", "--server", "prod", "--no-claude"],
          { env },
        );
        expect(login.code).toBe(1);
        expect(readFileSync(path, "utf8")).toBe(content);
      }
      writeFileSync(path, '{"version": 3}');
      expect((await cli(["mcp-headers"], { env })).stderr).toContain(
        "unknown version 3",
      );
    } finally {
      cleanup();
    }
  });

  test("accept-invite with a link to an unknown server asks for --server", async () => {
    const { env, cleanup } = savedAgents();
    const api = fakeApi();
    try {
      const result = await cli(
        [
          "accept-invite",
          "https://tracker.example.com/agent-invite/ABCD-EFGH",
          "--no-claude",
        ],
        {
          env,
          fetch: api.fetch,
        },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("https://tracker.example.com");
      expect(result.stderr).toContain("--server");
      expect(api.requests).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("whoami names the saved agent and talks to its server", async () => {
    const { env, cleanup } = savedAgents();
    try {
      const api = fakeApi();
      const result = await cli(["whoami", "--as", "prod/acme/writer"], {
        env,
        fetch: api.fetch,
      });
      expect(result.stdout).toBe(
        "@bot (Bot, member) in acme · saved agent prod/acme/writer\n",
      );
      expect(api.requests[0]?.url).toBe("https://api.test/v1/whoami");
      expect(api.requests[0]?.headers.get("Authorization")).toBe(
        "Bearer spt_wri",
      );
    } finally {
      cleanup();
    }
  });

  test("agents: list grouped with the default marked, set the default, remove", async () => {
    const { env, cleanup } = savedAgents();
    try {
      const listed = await cli(["agents"], { env });
      expect(listed.stdout).toBe(
        [
          "prod  https://api.test",
          "  acme  Acme",
          "    * reviewer  reviewer · ST",
          "      writer  writer · all projects",
          "local  http://localhost:4000",
          "  acme  Acme",
          "      writer  writer · all projects",
          "",
        ].join("\n"),
      );
      expect(listed.stdout).not.toContain("spt_");
      expect(
        (await cli(["agents", "default", "local/acme/writer"], { env })).code,
      ).toBe(0);
      const json = JSON.parse(
        (await cli(["agents", "list", "--json"], { env })).stdout,
      ) as { default: string };
      expect(json.default).toBe("local/acme/writer");
      const removed = await cli(["agents", "remove", "local/acme/writer"], {
        env,
      });
      expect(removed.stdout).toContain("Its key still works on the server");
      expect((await cli(["mcp-headers"], { env })).code).toBe(4);
      expect((await cli(["agents", "remove", "nobody"], { env })).code).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("claude launches Claude Code as the agent with a secret-free MCP config", async () => {
    const { home, env, cleanup } = savedAgents();
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "agents", "code-reviewer.md"),
      "---\nname: code-reviewer\ndescription: Reviews code\nspider-agent: prod/acme/reviewer\n---\nYou review code.\n",
    );
    const launched: {
      argv: string[];
      env: Record<string, string | undefined>;
      config: string;
      configPath: string;
    }[] = [];
    const spawn: RunOptions["spawn"] = async (argv, opts) => {
      const configPath = argv[argv.indexOf("--mcp-config") + 1] ?? "";
      launched.push({
        argv,
        env: opts.env,
        config: readFileSync(configPath, "utf8"),
        configPath,
      });
      return 7;
    };
    const self = ["/usr/local/bin/bun", "/repo/backend/cli/src/index.ts"];
    try {
      const started = await cli(
        ["claude", "reviewer", "--", "--model", "opus"],
        {
          env: { ...env, SPIDER_TOKEN: "spt_env" },
          spawn,
          self,
        },
      );
      expect(started.code).toBe(7);
      expect(started.stderr).toContain(
        "Permission mode: auto (spider default)\n",
      );
      expect(started.stderr).toContain("confirm development channels");
      const [first] = launched;
      expect(first?.argv).toEqual([
        "claude",
        "--model",
        "opus",
        "--permission-mode",
        "auto",
        "--agent",
        "code-reviewer",
        "--mcp-config",
        first?.configPath ?? "",
        "--dangerously-load-development-channels",
        "server:spider-channel",
      ]);
      expect(first?.env.SPIDER_AGENT).toBe("prod/acme/reviewer");
      expect(first?.env).not.toHaveProperty("SPIDER_TOKEN");
      expect(JSON.parse(first?.config ?? "")).toEqual({
        mcpServers: {
          spider: {
            type: "http",
            url: "https://api.test/mcp",
            headersHelper:
              "/usr/local/bin/bun /repo/backend/cli/src/index.ts mcp-headers --as prod/acme/reviewer --server prod",
          },
          "spider-channel": {
            type: "stdio",
            command: "/usr/local/bin/bun",
            args: [
              "/repo/backend/cli/src/index.ts",
              "channel",
              "--as",
              "prod/acme/reviewer",
            ],
          },
        },
      });
      expect(first?.config).not.toContain("spt_");
      expect(existsSync(first?.configPath ?? "")).toBe(false);

      // No agent and no picker: the default; --no-channel leaves the channel out.
      await cli(["claude", "--no-channel"], { env, spawn, self });
      expect(launched[1]?.argv.slice(-2)).toEqual([
        "--mcp-config",
        launched[1]?.configPath ?? "",
      ]);
      expect(launched[1]?.env.SPIDER_AGENT).toBe("prod/acme/reviewer");
      expect(
        JSON.parse(launched[1]?.config ?? "").mcpServers,
      ).not.toHaveProperty("spider-channel");

      // At a terminal, a picker grouped by server and org.
      let asked: unknown;
      await cli(["claude"], {
        env,
        spawn,
        self,
        select: async (_question, choices) => {
          asked = choices.map((c) => [c.group, c.value]);
          return "local/acme/writer";
        },
      });
      expect(asked).toEqual([
        ["prod › acme", "prod/acme/reviewer"],
        ["prod › acme", "prod/acme/writer"],
        ["local › acme", "local/acme/writer"],
      ]);
      expect(launched[2]?.env.SPIDER_AGENT).toBe("local/acme/writer");
      expect(launched[2]?.argv).not.toContain("--agent");
      expect(JSON.parse(launched[2]?.config ?? "").mcpServers.spider.url).toBe(
        "http://localhost:4000/mcp",
      );
    } finally {
      cleanup();
    }
  });
  test("claude starts in an explicit permission mode: the option, claude's own, the agent's, else auto", async () => {
    const { env, cleanup } = savedAgents();
    const launched: string[][] = [];
    const spawn: RunOptions["spawn"] = async (argv) => (launched.push(argv), 0);
    const self = ["spider"];
    const modeOf = (argv: string[] | undefined) =>
      argv?.[argv.indexOf("--permission-mode") + 1];
    try {
      const flag = await cli(
        ["claude", "reviewer", "--permission-mode", "acceptEdits"],
        { env, spawn, self },
      );
      expect(modeOf(launched[0])).toBe("acceptEdits");
      expect(flag.stderr).toContain(
        "Permission mode: acceptEdits (--permission-mode)\n",
      );

      // Claude's own flag after -- is kept as given, not doubled.
      const passed = await cli(
        ["claude", "reviewer", "--", "--permission-mode", "plan"],
        { env, spawn, self },
      );
      expect(
        launched[1]?.filter((a) => a === "--permission-mode"),
      ).toHaveLength(1);
      expect(modeOf(launched[1])).toBe("plan");
      expect(passed.stderr).toContain(
        "Permission mode: plan (claude arguments)\n",
      );
      await cli(
        ["claude", "reviewer", "--", "--dangerously-skip-permissions"],
        { env, spawn, self },
      );
      expect(launched[2]).not.toContain("--permission-mode");

      // Both: a usage error, nothing started.
      const both = await cli(
        [
          "claude",
          "reviewer",
          "--permission-mode",
          "auto",
          "--",
          "--permission-mode",
          "plan",
        ],
        { env, spawn, self },
      );
      expect(both.code).toBe(2);
      expect(launched).toHaveLength(3);
      expect(
        (
          await cli(["claude", "reviewer", "--permission-mode", "yolo"], {
            env,
            spawn,
            self,
          })
        ).code,
      ).toBe(2);

      // Saved per agent.
      const set = await cli(
        ["agents", "permission-mode", "reviewer", "manual", "--json"],
        { env },
      );
      expect(JSON.parse(set.stdout)).toEqual({
        agent: "prod/acme/reviewer",
        permissionMode: "manual",
        effective: "manual",
      });
      const saved = await cli(["claude", "reviewer"], { env, spawn, self });
      expect(modeOf(launched[3])).toBe("manual");
      expect(saved.stderr).toContain(
        "Permission mode: manual (saved for this agent)\n",
      );
      await cli(["claude", "prod/acme/writer"], { env, spawn, self });
      expect(modeOf(launched[4])).toBe("auto");
      const listed = JSON.parse(
        (await cli(["agents", "--json"], { env })).stdout,
      ) as { items: { agent: string; permissionMode: string | null }[] };
      expect(
        listed.items.find((a) => a.agent === "prod/acme/reviewer")
          ?.permissionMode,
      ).toBe("manual");

      const cleared = await cli(
        ["agents", "permission-mode", "reviewer", "--clear"],
        { env },
      );
      expect(cleared.stdout).toContain("starts in auto (the spider default)");
      await cli(["claude", "reviewer"], { env, spawn, self });
      expect(modeOf(launched[5])).toBe("auto");
      expect(
        (await cli(["agents", "permission-mode", "reviewer", "yolo"], { env }))
          .code,
      ).toBe(2);

      // --permission-mode as the last word after --: a usage error, not "--permission-mode
      // --permission-mode auto" (ST-125).
      for (const last of ["--permission-mode", "--permission-mode="]) {
        const dangling = await cli(["claude", "reviewer", "--", "-p", last], {
          env,
          spawn,
          self,
        });
        expect(dangling.code).toBe(2);
        expect(dangling.stderr).toContain(
          "--permission-mode after -- needs a mode",
        );
      }
      expect(launched).toHaveLength(6);
    } finally {
      cleanup();
    }
  });

  test("claude ignores a saved permission mode Claude Code doesn't know, with a warning (ST-125)", async () => {
    const { home, env, cleanup } = savedAgents();
    const file = join(home, "config", "credentials.json");
    const store = JSON.parse(readFileSync(file, "utf8")) as Store;
    const reviewer = store.servers.prod?.orgs.acme?.agents.reviewer;
    if (!reviewer) throw new Error("expected the reviewer");
    reviewer.permissionMode = "yolo";
    writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
    const launched: string[][] = [];
    try {
      const started = await cli(["claude", "reviewer"], {
        env,
        spawn: async (argv) => (launched.push(argv), 0),
        self: ["spider"],
      });
      expect(started.code).toBe(0);
      expect(launched[0]).not.toContain("yolo");
      expect(started.stderr).toContain(
        'Warning: the permission mode saved for @reviewer ("yolo") isn\'t one Claude Code knows',
      );
      expect(started.stderr).toContain(
        "Permission mode: auto (spider default)",
      );
    } finally {
      cleanup();
    }
  });

  test("claude warns about a settings hook whose script is gone", async () => {
    const { home, env, cleanup } = savedAgents();
    mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(home, ".claude", "hooks", "present.js"), "");
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node "${join(home, ".claude", "hooks", "gone.js")}"`,
                },
              ],
            },
            {
              hooks: [
                { type: "command", command: "node ~/.claude/hooks/present.js" },
              ],
            },
          ],
        },
      }),
    );
    try {
      const started = await cli(["claude", "reviewer", "--no-channel"], {
        env,
        spawn: async () => 0,
        self: ["spider"],
        cwd: home,
      });
      expect(started.code).toBe(0);
      expect(started.stderr).toContain(
        `Warning: a SessionStart hook in ${join(home, ".claude", "settings.json")} runs ${join(home, ".claude", "hooks", "gone.js")}, which doesn't exist`,
      );
      expect(started.stderr).not.toContain("present.js");
      expect(started.stderr).not.toContain("development channels");
    } finally {
      cleanup();
    }
  });
});

describe("Claude Code plugins", () => {
  /** A fake `claude`: records calls; `missing` makes it not installed. */
  const fakeClaude = (missing = false) => {
    const calls: string[][] = [];
    const runClaude: RunOptions["runClaude"] = async (args) => {
      calls.push(args);
      return missing ? undefined : { exitCode: 0, output: "" };
    };
    return { calls, runClaude };
  };
  const acceptApi = fakeApi({
    "POST /v1/agent-invites/accept": () =>
      Response.json({
        token: "spt_new",
        actor: {
          id: "a2",
          type: "agent",
          name: "Builder",
          handle: "builder",
          avatarUrl: null,
          role: "member",
        },
        organization: { id: "o", slug: "acme", name: "Acme" },
        projects: [{ key: "ST", name: "Spider" }],
        owner: { id: "u", name: "Ann", handle: "ann" },
      }),
  });

  test("accept-invite writes the agent into the private plugin and installs it", async () => {
    const { env, cleanup } = savedAgents();
    const { calls, runClaude } = fakeClaude();
    const root = join(env.SPIDER_CONFIG_DIR, "claude-plugin");
    try {
      const accepted = await cli(
        [
          "accept-invite",
          "ABCD-EFGH",
          "--server",
          "prod",
          "--name",
          "Builder",
          "--description",
          "Builds things",
          "--prompt",
          "You build.",
          "--json",
        ],
        { env, fetch: acceptApi.fetch, runClaude },
      );
      expect(accepted.code).toBe(0);
      const path = join(
        root,
        "spider-agents",
        "agents",
        "prod",
        "acme",
        "builder.md",
      );
      expect(JSON.parse(accepted.stdout).claudeAgent).toEqual({
        plugin: "spider-agents",
        name: "builder",
        path,
        qualifiedName: "spider-agents:prod:acme:builder",
      });
      const text = readFileSync(path, "utf8");
      expect(text).toContain("spider-agent: prod/acme/builder");
      expect(text).toContain("\nYou build.\n");
      expect(text).not.toContain("spt_");
      expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(
        true,
      );
      expect(calls).toEqual([
        ["plugin", "marketplace", "add", root],
        ["plugin", "install", "spider-agents@spider-local", "--scope", "user"],
      ]);

      // spider claude starts it as the plugin agent.
      let launched: string[] = [];
      await cli(["claude", "builder"], {
        env,
        self: ["spider"],
        spawn: async (argv) => ((launched = argv), 0),
      });
      expect(launched.slice(0, 5)).toEqual([
        "claude",
        "--permission-mode",
        "auto",
        "--agent",
        "spider-agents:prod:acme:builder",
      ]);

      // remove --claude deletes it.
      const removed = await cli(
        ["agents", "remove", "builder", "--claude", "--json"],
        { env },
      );
      expect(JSON.parse(removed.stdout).claudeAgentsDeleted).toEqual([path]);
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("accept-invite --no-claude writes nothing; without claude it still writes the file", async () => {
    const { env, cleanup } = savedAgents();
    const { calls, runClaude } = fakeClaude(true);
    const root = join(env.SPIDER_CONFIG_DIR, "claude-plugin");
    try {
      const skipped = await cli(
        [
          "accept-invite",
          "ABCD-EFGH",
          "--server",
          "prod",
          "--no-claude",
          "--json",
        ],
        {
          env,
          fetch: acceptApi.fetch,
          runClaude,
        },
      );
      expect(skipped.code).toBe(0);
      expect(JSON.parse(skipped.stdout).claudeAgent).toBeNull();
      expect(existsSync(root)).toBe(false);
      expect(calls).toEqual([]);

      const noClaude = await cli(
        ["accept-invite", "ABCD-EFGH", "--server", "prod"],
        { env, fetch: acceptApi.fetch, runClaude },
      );
      expect(noClaude.code).toBe(0);
      expect(noClaude.stdout).toContain("Claude Code is not installed");
      expect(
        existsSync(
          join(root, "spider-agents", "agents", "prod", "acme", "builder.md"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("setup claude installs both plugins at user scope, idempotently", async () => {
    const { env, cleanup } = savedAgents();
    const { calls, runClaude } = fakeClaude();
    const root = join(env.SPIDER_CONFIG_DIR, "claude-plugin");
    try {
      for (let i = 0; i < 2; i++) {
        const done = await cli(["setup", "claude", "--json"], {
          env,
          runClaude,
        });
        expect(done.code).toBe(0);
        expect(JSON.parse(done.stdout)).toEqual({
          scope: "user",
          claude: true,
          marketplace: "pipisasa/spider-tracker",
          plugin: "spider-tracker@spider-tracker",
          agentsPlugin: "spider-agents@spider-local",
        });
      }
      const once = [
        ["plugin", "marketplace", "add", "pipisasa/spider-tracker"],
        [
          "plugin",
          "install",
          "spider-tracker@spider-tracker",
          "--scope",
          "user",
        ],
        ["plugin", "marketplace", "add", root],
        ["plugin", "install", "spider-agents@spider-local", "--scope", "user"],
      ];
      expect(calls).toEqual([...once, ...once]);

      // SPIDER_PLUGIN_MARKETPLACE overrides the source; a relative path is resolved.
      calls.length = 0;
      await cli(["setup", "claude"], {
        env: { ...env, SPIDER_PLUGIN_MARKETPLACE: "./repo" },
        runClaude,
        cwd: "/work",
      });
      expect(calls[0]).toEqual(["plugin", "marketplace", "add", "/work/repo"]);

      // A failing claude command is exit 1; a missing claude is a note and exit 0.
      const failing = await cli(["setup", "claude"], {
        env,
        runClaude: async () => ({ exitCode: 1, output: "boom" }),
      });
      expect(failing.code).toBe(1);
      expect(failing.stderr).toContain("boom");
      const missing = await cli(["setup", "claude", "--json"], {
        env,
        runClaude: fakeClaude(true).runClaude,
      });
      expect(missing.code).toBe(0);
      expect(JSON.parse(missing.stdout).claude).toBe(false);
      expect(missing.stderr).toContain(
        "curl -fsSL https://claude.ai/install.sh",
      );
    } finally {
      cleanup();
    }
  });

  test("setup claude --project merges into .claude/settings.json", async () => {
    const { home, env, cleanup } = savedAgents();
    const { calls, runClaude } = fakeClaude();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        enabledPlugins: { "other@x": true },
        extraKnownMarketplaces: { x: {} },
      }),
    );
    try {
      const done = await cli(["setup", "claude", "--project"], {
        env,
        runClaude,
        cwd: home,
      });
      expect(done.code).toBe(0);
      expect(calls).toEqual([]);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
        permissions: { allow: ["Bash(ls)"] },
        enabledPlugins: {
          "other@x": true,
          "spider-tracker@spider-tracker": true,
        },
        extraKnownMarketplaces: {
          x: {},
          "spider-tracker": {
            source: { source: "github", repo: "pipisasa/spider-tracker" },
          },
        },
      });
      await cli(["setup", "claude", "--project"], {
        env: { ...env, SPIDER_PLUGIN_MARKETPLACE: "/src/spider" },
        cwd: home,
      });
      expect(
        JSON.parse(readFileSync(settings, "utf8")).extraKnownMarketplaces[
          "spider-tracker"
        ],
      ).toEqual({
        source: { source: "directory", path: "/src/spider" },
      });
    } finally {
      cleanup();
    }
  });
});
