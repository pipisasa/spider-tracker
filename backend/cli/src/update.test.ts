import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type RunOptions } from "./cli";
import { claudeAgentMarkdown } from "./claude-agents";
import {
  PLUGIN_MANIFEST_URL,
  RELEASES_API,
  checkForUpdates,
  isFresh,
} from "./update-check";
import { commandOf } from "./update";
import { CLI_VERSION, compareVersions, isNewer, parseVersion } from "./version";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

/** A temp HOME with a config dir; `plugin` is the installed spider-tracker version, if any. */
function home(plugin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "spider-update-"));
  homes.push(dir);
  const env: Record<string, string | undefined> = {
    HOME: dir,
    SPIDER_CONFIG_DIR: join(dir, "config"),
  };
  if (plugin) {
    const path = join(dir, ".claude", "plugins", "installed_plugins.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        plugins: {
          "spider-tracker@spider-tracker": [{ scope: "user", version: plugin }],
        },
      }),
    );
  }
  return { dir, env };
}

const bump = (version: string, by = 1) => {
  const [major = 0, minor = 0] = parseVersion(version) ?? [];
  return `${major}.${minor + by}.0`;
};
const NEWER = bump(CLI_VERSION);

/** Fake GitHub: the latest release tag and the plugin manifest version; records requested URLs. */
function github({
  tag = `cli-v${CLI_VERSION}`,
  plugin = "0.3.0",
  list = [] as string[],
} = {}) {
  const urls: string[] = [];
  const fetch = async (input: string) => {
    urls.push(input);
    if (input === `${RELEASES_API}/latest`)
      return Response.json({ tag_name: tag });
    if (input.startsWith(`${RELEASES_API}?`))
      return Response.json(list.map((t) => ({ tag_name: t })));
    if (input === PLUGIN_MANIFEST_URL)
      return Response.json({ name: "spider-tracker", version: plugin });
    return new Response("not found", { status: 404 });
  };
  return { fetch, urls };
}

/** A fake API that knows whoami and lists nothing, sending `headers` on every response. */
const api =
  (headers: Record<string, string> = {}) =>
  (input: string) =>
    input.endsWith("/v1/whoami")
      ? Response.json(
          { actor: { handle: "bot" }, organization: { slug: "acme" } },
          { headers },
        )
      : Response.json({ items: [] }, { headers });

async function cli(
  argv: string[],
  options: Partial<RunOptions> & { env: RunOptions["env"] },
) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    fetch: api(),
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    ...options,
  });
  return { code, stdout, stderr };
}

const writeCache = (
  env: Record<string, string | undefined>,
  cli: string,
  ageMs = 0,
) => {
  mkdirSync(env.SPIDER_CONFIG_DIR ?? "", { recursive: true });
  writeFileSync(
    join(env.SPIDER_CONFIG_DIR ?? "", "update-check.json"),
    JSON.stringify({
      checkedAt: new Date(Date.now() - ageMs).toISOString(),
      cli,
      plugin: "0.3.0",
    }),
  );
};

describe("versions", () => {
  test("parse and compare", () => {
    expect(parseVersion("cli-v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v0.10.0-beta.1")).toEqual([0, 10, 0]);
    expect(parseVersion("latest")).toBeUndefined();
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer(null, "0.1.0")).toBe(false);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
  });

  test("commandOf skips global options", () => {
    expect(commandOf(["--as", "bot", "task", "list"])).toBe("task");
    expect(commandOf(["--json"])).toBeUndefined();
  });
});

describe("update check cache", () => {
  test("fresh for a day; a stale cache is refreshed and saved 0600", async () => {
    const { env } = home();
    const gh = github({ tag: `cli-v${NEWER}` });
    const first = await checkForUpdates(env, gh.fetch);
    expect(first).toMatchObject({ cli: NEWER, plugin: "0.3.0" });
    const path = join(env.SPIDER_CONFIG_DIR ?? "", "update-check.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(isFresh(first)).toBe(true);
    expect(isFresh(first, Date.now() + 25 * 60 * 60 * 1000)).toBe(false);

    gh.urls.length = 0;
    await checkForUpdates(env, gh.fetch);
    expect(gh.urls).toEqual([]);
    await checkForUpdates(env, gh.fetch, {
      now: Date.now() + 25 * 60 * 60 * 1000,
    });
    expect(gh.urls.length).toBeGreaterThan(0);
  });

  test("a non-cli latest release falls back to the release list", async () => {
    const { env } = home();
    const gh = github({
      tag: "web-v9.9.9",
      list: ["web-v9.9.9", `cli-v${NEWER}`, "cli-v0.0.1"],
    });
    expect((await checkForUpdates(env, gh.fetch)).cli).toBe(NEWER);
  });
});

describe("passive notice", () => {
  const notice = `A new spider is available: ${CLI_VERSION} → ${NEWER}. Run: spider update\n`;

  test("shown after a command at a terminal when the cache knows a newer release", async () => {
    const { env } = home();
    writeCache(env, NEWER);
    const gh = github();
    const result = await cli(["projects"], {
      env: { ...env, SPIDER_TOKEN: "spt_x" },
      isInteractive: true,
      httpFetch: gh.fetch,
    });
    expect(result.stderr).toBe(notice);
    expect(gh.urls).toEqual([]);
  });

  test("not shown for --json, non-interactive runs, SPIDER_NO_UPDATE_CHECK, CI or quiet commands", async () => {
    const { env } = home();
    writeCache(env, NEWER);
    const base = { ...env, SPIDER_TOKEN: "spt_x" };
    const runs = [
      await cli(["projects", "--json"], { env: base, isInteractive: true }),
      await cli(["projects"], { env: base, isInteractive: false }),
      await cli(["projects"], {
        env: { ...base, SPIDER_NO_UPDATE_CHECK: "1" },
        isInteractive: true,
      }),
      await cli(["projects"], {
        env: { ...base, CI: "true" },
        isInteractive: true,
      }),
      await cli(["mcp-headers"], { env: base, isInteractive: true }),
    ];
    for (const r of runs) expect(r.stderr).not.toContain("A new spider");
  });

  test("a stale cache is refreshed in the background", async () => {
    const { env } = home();
    writeCache(env, CLI_VERSION, 2 * 24 * 60 * 60 * 1000);
    const gh = github({ tag: `cli-v${NEWER}` });
    const result = await cli(["projects"], {
      env: { ...env, SPIDER_TOKEN: "spt_x" },
      isInteractive: true,
      httpFetch: gh.fetch,
    });
    expect(result.stderr).toBe(notice);
    expect(
      JSON.parse(
        readFileSync(
          join(env.SPIDER_CONFIG_DIR ?? "", "update-check.json"),
          "utf8",
        ),
      ).cli,
    ).toBe(NEWER);
  });
});

test("warns once per run when the server needs a newer CLI, even with --json", async () => {
  const { env } = home();
  const fetch = api({ "X-Spider-Min-Cli": NEWER });
  const old = await cli(["projects", "--json"], {
    env: { ...env, SPIDER_TOKEN: "spt_x" },
    fetch,
  });
  expect(old.code).toBe(0);
  expect(old.stderr).toBe(
    `This spider (${CLI_VERSION}) is older than the server supports (${NEWER}); some commands may fail. Run: spider update\n`,
  );
  const ok = await cli(["projects"], {
    env: { ...env, SPIDER_TOKEN: "spt_x" },
    fetch: api({ "X-Spider-Min-Cli": CLI_VERSION }),
  });
  expect(ok.stderr).toBe("");
});

describe("spider update", () => {
  const agentFile = (version: string) =>
    claudeAgentMarkdown(
      {
        server: "prod",
        org: "acme",
        agent: "bot",
        ref: "prod/acme/bot",
        serverUrl: "",
        saved: {
          token: "",
          actor: { id: "", name: "Bot", handle: "bot", type: "agent" },
        },
      } as never,
      "bot",
      { description: "d", prompt: "You review.", projects: null },
      version,
    );
  const withAgent = (
    env: Record<string, string | undefined>,
    version: string,
  ) => {
    const path = join(
      env.SPIDER_CONFIG_DIR ?? "",
      "claude-plugin",
      "spider-agents",
      "agents",
      "prod",
      "acme",
      "bot.md",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, agentFile(version));
    return path;
  };

  test("--check --json reports the CLI, the plugin and agent files, ignoring a fresh cache", async () => {
    const { env } = home("0.2.0");
    writeCache(env, CLI_VERSION);
    const path = withAgent(env, "0.0.1");
    const gh = github({ tag: `cli-v${NEWER}`, plugin: "0.3.0" });
    const result = await cli(["update", "--check", "--json"], {
      env,
      httpFetch: gh.fetch,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cli: { current: CLI_VERSION, latest: NEWER, outdated: true },
      plugin: {
        id: "spider-tracker@spider-tracker",
        installed: "0.2.0",
        latest: "0.3.0",
        outdated: true,
      },
      agents: [
        { path, agent: "prod/acme/bot", state: "outdated", version: "0.0.1" },
      ],
    });
    // --check only reports.
    expect(readFileSync(path, "utf8")).toBe(agentFile("0.0.1"));
  });

  test("--hook prints nothing when everything is current", async () => {
    const { env } = home("0.3.0");
    withAgent(env, CLI_VERSION);
    const result = await cli(["update", "--check", "--hook"], {
      env,
      httpFetch: github().fetch,
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("--hook gives Claude Code a SessionStart context note when something is out of date", async () => {
    const { env } = home("0.2.0");
    const result = await cli(["update", "--check", "--hook"], {
      env,
      httpFetch: github({ tag: `cli-v${NEWER}` }).fetch,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Spider Tracker: the spider CLI ${CLI_VERSION} is out of date (latest ${NEWER}) and the spider-tracker plugin 0.2.0 is out of date (latest 0.3.0). Tell the user and offer to run \`spider update\` (then restart Claude Code).`,
      },
    });
  });

  test("--hook never fails, even offline", async () => {
    const { env } = home("0.2.0");
    const result = await cli(["update", "--check", "--hook"], {
      env,
      httpFetch: () => Promise.reject(new Error("offline")),
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("updates the binary, the plugin through claude and the agent files", async () => {
    const { env } = home("0.2.0");
    const path = withAgent(env, "0.0.1");
    const calls: string[][] = [];
    const runClaude: RunOptions["runClaude"] = async (args) => {
      calls.push(args);
      if (args[1] === "list") return { exitCode: 1, output: "" };
      if (args[1] === "update")
        return {
          exitCode: 0,
          output: `Checking…\n${JSON.stringify({ oldVersion: "0.2.0", newVersion: "0.3.0" })}\n`,
        };
      return { exitCode: 0, output: "" };
    };
    const updated: string[] = [];
    const result = await cli(["update"], {
      env,
      httpFetch: github({ tag: `cli-v${NEWER}` }).fetch,
      runClaude,
      selfUpdate: async (version) => updated.push(version),
    });
    expect(result.code).toBe(0);
    expect(updated).toEqual([NEWER]);
    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "update", "spider-tracker"],
      ["plugin", "update", "spider-tracker@spider-tracker", "--json"],
    ]);
    expect(readFileSync(path, "utf8")).toBe(agentFile(CLI_VERSION));
    expect(result.stdout).toBe(
      [
        `Updated spider ${CLI_VERSION} → ${NEWER}`,
        "Updated spider-tracker@spider-tracker 0.2.0 → 0.3.0",
        "Refreshed the Spider Tracker section of 1 agent file",
        "Restart Claude Code sessions to load the updates.",
        "",
      ].join("\n"),
    );
  });

  test("from source it says to git pull; without claude it skips the plugin", async () => {
    const { env } = home("0.2.0");
    const result = await cli(["update", "--json"], {
      env,
      httpFetch: github({ tag: `cli-v${NEWER}` }).fetch,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cli: {
        from: CLI_VERSION,
        to: NEWER,
        updated: false,
        note: expect.stringContaining(
          "Running from source: update with git pull",
        ),
      },
      plugin: {
        updated: false,
        note: expect.stringContaining("not available"),
      },
      agents: { refreshed: [], unmanaged: [] },
      restart: false,
    });
  });

  test("already current: nothing is replaced", async () => {
    const { env } = home("0.3.0");
    const updated: string[] = [];
    const result = await cli(["update"], {
      env,
      httpFetch: github().fetch,
      runClaude: async () => ({ exitCode: 0, output: "" }),
      selfUpdate: async (version) => updated.push(version),
    });
    expect(updated).toEqual([]);
    expect(result.stdout).toContain(`spider ${CLI_VERSION} is up to date`);
    expect(result.stdout).toContain(
      "spider-tracker@spider-tracker 0.3.0 is up to date",
    );
  });
});
