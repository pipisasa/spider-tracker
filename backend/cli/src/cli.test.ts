import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunOptions } from "./cli";
import type { Store } from "./credentials";
import { CLI_VERSION } from "./version";

const project = {
  id: "p",
  key: "ST",
  name: "Spider",
  description: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  statuses: [{ id: "s1", name: "Todo", category: "todo", color: null, position: 1 }],
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
        actor: { id: "agent", type: "agent", name: "Bot", handle: "bot", avatarUrl: null, role: "member" },
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
    return route ? route() : Response.json({ error: { code: "not_found", message: "Task not found" } }, { status: 404 });
  };
  return { fetch, requests };
}

async function cli(argv: string[], options: Partial<RunOptions> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: { SPIDER_TOKEN: "spt_secret", SPIDER_API_URL: "https://api.test" },
    fetch: fakeApi().fetch,
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
    expect(api.requests[0]?.headers.get("Authorization")).toBe("Bearer spt_secret");
    expect(api.requests[0]?.headers.get("X-Spider-Source")).toBe("cli");
    expect(result.stdout + result.stderr).not.toContain("spt_secret");
  });

  test("2 for usage and validation errors", async () => {
    expect((await cli(["task", "frobnicate"])).code).toBe(2);
    expect((await cli(["task", "create", "--title", "No project"])).code).toBe(2);
    expect((await cli(["task", "view", "not a key"])).code).toBe(2);
    expect((await cli(["task", "update", "ST-1", "--priority", "9"])).stderr).toContain("Invalid priority");
    expect((await cli(["task", "update", "ST-1"])).stderr).toBe("spider: Nothing to update. Pass --title, --status, --assign, …\n");
    expect((await cli(["task", "update", "ST-1", "--status", "Shipped"])).code).toBe(2);
    expect((await cli(["task", "start", "ST-1"])).stderr).toContain('ST has no "in_progress" status');
  });

  test("2 when the key is omitted and the branch has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spider-cli-"));
    try {
      const result = await cli(["task", "view"], { cwd: dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("No task key given");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mcp-headers prints the Authorization header for Claude Code", async () => {
    const result = await cli(["mcp-headers"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer spt_secret" });
  });

  test("parse errors are JSON on stderr under --json", async () => {
    const result = await cli(["task", "list", "--json", "--bogus"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "usage", message: "unknown option '--bogus'" } });
  });

  test("3 when the task is missing, with a JSON error on stderr under --json", async () => {
    const result = await cli(["task", "view", "ST-9", "--json"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "not_found", message: "Task not found" } });
  });

  test("4 without a token or when the API refuses it", async () => {
    const missing = await cli(["whoami"], { env: {} });
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain("Not signed in");

    const refused = fakeApi({
      "GET /v1/whoami": () =>
        Response.json({ error: { code: "unauthorized", message: "Invalid or revoked API key" } }, { status: 401 }),
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

  test("--help and --version exit 0 without a token", async () => {
    const help = await cli(["task", "--help"], { env: {} });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("start [options] [key]");
    expect((await cli(["--version"], { env: {} })).stdout).toBe(`${CLI_VERSION}\n`);
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
        orgs: { acme: { name: "Acme", agents: { reviewer: saved("reviewer", "spt_rev"), writer: saved("writer", "spt_wri") } } },
      },
      local: { url: "http://localhost:4000", orgs: { acme: { name: "Acme", agents: { writer: saved("writer", "spt_local") } } } },
    },
  };
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify(store), { mode: 0o600 });
  const env = { HOME: home, SPIDER_CONFIG_DIR: configDir };
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("saved agents", () => {
  test("which key: --as > SPIDER_TOKEN > SPIDER_AGENT > default", async () => {
    const { env, cleanup } = savedAgents();
    const token = async (argv: string[], extra: Record<string, string> = {}) => {
      const result = await cli(argv, { env: { ...env, ...extra } });
      return result.code === 0 ? (JSON.parse(result.stdout) as { Authorization: string }).Authorization : result.stderr;
    };
    try {
      expect(await token(["mcp-headers"])).toBe("Bearer spt_rev");
      expect(await token(["mcp-headers"], { SPIDER_AGENT: "prod/acme/writer" })).toBe("Bearer spt_wri");
      expect(await token(["mcp-headers"], { SPIDER_AGENT: "local/acme/writer", SPIDER_TOKEN: "spt_env" })).toBe("Bearer spt_env");
      expect(await token(["mcp-headers", "--as", "local/acme/writer"], { SPIDER_TOKEN: "spt_env" })).toBe("Bearer spt_local");
      expect(await token(["--as", "reviewer", "mcp-headers"], { SPIDER_AGENT: "prod/acme/writer" })).toBe("Bearer spt_rev");
      const ambiguous = await cli(["mcp-headers", "--as", "writer"], { env });
      expect(ambiguous.code).toBe(2);
      expect(ambiguous.stderr).toContain("prod/acme/writer, local/acme/writer");
    } finally {
      cleanup();
    }
  });

  test("whoami names the saved agent and talks to its server", async () => {
    const { env, cleanup } = savedAgents();
    try {
      const api = fakeApi();
      const result = await cli(["whoami", "--as", "prod/acme/writer"], { env, fetch: api.fetch });
      expect(result.stdout).toBe("@bot (Bot, member) in acme · saved agent prod/acme/writer\n");
      expect(api.requests[0]?.url).toBe("https://api.test/v1/whoami");
      expect(api.requests[0]?.headers.get("Authorization")).toBe("Bearer spt_wri");
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
      expect((await cli(["agents", "default", "local/acme/writer"], { env })).code).toBe(0);
      const json = JSON.parse((await cli(["agents", "list", "--json"], { env })).stdout) as { default: string };
      expect(json.default).toBe("local/acme/writer");
      const removed = await cli(["agents", "remove", "local/acme/writer"], { env });
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
    const launched: { argv: string[]; env: Record<string, string | undefined>; config: string; configPath: string }[] = [];
    const spawn: RunOptions["spawn"] = async (argv, opts) => {
      const configPath = argv[argv.indexOf("--mcp-config") + 1] ?? "";
      launched.push({ argv, env: opts.env, config: readFileSync(configPath, "utf8"), configPath });
      return 7;
    };
    const self = ["/usr/local/bin/bun", "/repo/backend/cli/src/index.ts"];
    try {
      const started = await cli(["claude", "reviewer", "--", "--model", "opus"], {
        env: { ...env, SPIDER_TOKEN: "spt_env" },
        spawn,
        self,
      });
      expect(started.code).toBe(7);
      const [first] = launched;
      expect(first?.argv).toEqual([
        "claude",
        "--model",
        "opus",
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
            headersHelper: "/usr/local/bin/bun /repo/backend/cli/src/index.ts mcp-headers --as prod/acme/reviewer",
          },
          "spider-channel": {
            type: "stdio",
            command: "/usr/local/bin/bun",
            args: ["/repo/backend/cli/src/index.ts", "channel", "--as", "prod/acme/reviewer"],
          },
        },
      });
      expect(first?.config).not.toContain("spt_");
      expect(existsSync(first?.configPath ?? "")).toBe(false);

      // No agent and no picker: the default; --no-channel leaves the channel out.
      await cli(["claude", "--no-channel"], { env, spawn, self });
      expect(launched[1]?.argv.slice(-2)).toEqual(["--mcp-config", launched[1]?.configPath ?? ""]);
      expect(launched[1]?.env.SPIDER_AGENT).toBe("prod/acme/reviewer");
      expect(JSON.parse(launched[1]?.config ?? "").mcpServers).not.toHaveProperty("spider-channel");

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
      expect(JSON.parse(launched[2]?.config ?? "").mcpServers.spider.url).toBe("http://localhost:4000/mcp");
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
        actor: { id: "a2", type: "agent", name: "Builder", handle: "builder", avatarUrl: null, role: "member" },
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
        ["accept-invite", "ABCD-EFGH", "--server", "prod", "--name", "Builder", "--description", "Builds things", "--prompt", "You build.", "--json"],
        { env, fetch: acceptApi.fetch, runClaude },
      );
      expect(accepted.code).toBe(0);
      const path = join(root, "spider-agents", "agents", "prod", "acme", "builder.md");
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
      expect(existsSync(join(root, ".claude-plugin", "marketplace.json"))).toBe(true);
      expect(calls).toEqual([
        ["plugin", "marketplace", "add", root],
        ["plugin", "install", "spider-agents@spider-local", "--scope", "user"],
      ]);

      // spider claude starts it as the plugin agent.
      let launched: string[] = [];
      await cli(["claude", "builder"], { env, self: ["spider"], spawn: async (argv) => ((launched = argv), 0) });
      expect(launched.slice(0, 3)).toEqual(["claude", "--agent", "spider-agents:prod:acme:builder"]);

      // remove --claude deletes it.
      const removed = await cli(["agents", "remove", "builder", "--claude", "--json"], { env });
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
      const skipped = await cli(["accept-invite", "ABCD-EFGH", "--server", "prod", "--no-claude", "--json"], {
        env,
        fetch: acceptApi.fetch,
        runClaude,
      });
      expect(skipped.code).toBe(0);
      expect(JSON.parse(skipped.stdout).claudeAgent).toBeNull();
      expect(existsSync(root)).toBe(false);
      expect(calls).toEqual([]);

      const noClaude = await cli(["accept-invite", "ABCD-EFGH", "--server", "prod"], { env, fetch: acceptApi.fetch, runClaude });
      expect(noClaude.code).toBe(0);
      expect(noClaude.stdout).toContain("Claude Code is not installed");
      expect(existsSync(join(root, "spider-agents", "agents", "prod", "acme", "builder.md"))).toBe(true);
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
        const done = await cli(["setup", "claude", "--json"], { env, runClaude });
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
        ["plugin", "install", "spider-tracker@spider-tracker", "--scope", "user"],
        ["plugin", "marketplace", "add", root],
        ["plugin", "install", "spider-agents@spider-local", "--scope", "user"],
      ];
      expect(calls).toEqual([...once, ...once]);

      // SPIDER_PLUGIN_MARKETPLACE overrides the source; a relative path is resolved.
      calls.length = 0;
      await cli(["setup", "claude"], { env: { ...env, SPIDER_PLUGIN_MARKETPLACE: "./repo" }, runClaude, cwd: "/work" });
      expect(calls[0]).toEqual(["plugin", "marketplace", "add", "/work/repo"]);

      // A failing claude command is exit 1; a missing claude is a note and exit 0.
      const failing = await cli(["setup", "claude"], { env, runClaude: async () => ({ exitCode: 1, output: "boom" }) });
      expect(failing.code).toBe(1);
      expect(failing.stderr).toContain("boom");
      const missing = await cli(["setup", "claude", "--json"], { env, runClaude: fakeClaude(true).runClaude });
      expect(missing.code).toBe(0);
      expect(JSON.parse(missing.stdout).claude).toBe(false);
      expect(missing.stderr).toContain("curl -fsSL https://claude.ai/install.sh");
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
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, enabledPlugins: { "other@x": true }, extraKnownMarketplaces: { x: {} } }),
    );
    try {
      const done = await cli(["setup", "claude", "--project"], { env, runClaude, cwd: home });
      expect(done.code).toBe(0);
      expect(calls).toEqual([]);
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
        permissions: { allow: ["Bash(ls)"] },
        enabledPlugins: { "other@x": true, "spider-tracker@spider-tracker": true },
        extraKnownMarketplaces: { x: {}, "spider-tracker": { source: { source: "github", repo: "pipisasa/spider-tracker" } } },
      });
      await cli(["setup", "claude", "--project"], { env: { ...env, SPIDER_PLUGIN_MARKETPLACE: "/src/spider" }, cwd: home });
      expect(JSON.parse(readFileSync(settings, "utf8")).extraKnownMarketplaces["spider-tracker"]).toEqual({
        source: { source: "directory", path: "/src/spider" },
      });
    } finally {
      cleanup();
    }
  });
});
