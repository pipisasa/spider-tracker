import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunOptions } from "./cli";

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
    expect((await cli(["--version"], { env: {} })).stdout).toBe("0.1.0\n");
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
