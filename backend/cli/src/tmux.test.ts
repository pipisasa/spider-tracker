import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type RunOptions } from "./cli";
import type { SavedAgent, Store } from "./credentials";
import { shellQuote, windowCommand, type TmuxRunner } from "./tmux";

/** A fake tmux server: sessions and their window names; records every command. `missing` makes tmux not installed. */
function fakeTmux({
  missing = false,
  sessions = {} as Record<string, string[]>,
  failNewWindow = false,
} = {}) {
  const state = new Map(
    Object.entries(sessions).map(([name, windows]) => [name, [...windows]]),
  );
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });
  const flag = (args: string[], name: string) =>
    args[args.indexOf(name) + 1] ?? "";
  // Only exact targets (=name or =name:) are accepted, so a prefix match can never pick another session.
  const session = (target: string) => {
    expect(target.startsWith("=")).toBe(true);
    return target.slice(1).replace(/:$/, "");
  };
  const tmux: TmuxRunner = (args) => {
    if (missing) return { exitCode: 127, stdout: "", stderr: "tmux not found" };
    calls.push(args);
    const [command] = args;
    if (command === "-V") return ok("tmux 3.5a\n");
    if (command === "has-session")
      return state.has(session(flag(args, "-t")))
        ? ok()
        : fail("can't find session");
    if (command === "list-windows") {
      const windows = state.get(session(flag(args, "-t")));
      return windows
        ? ok(windows.map((w) => `${w}\n`).join(""))
        : fail("can't find session");
    }
    if (command === "new-session") {
      const name = flag(args, "-s");
      if (state.has(name)) return fail(`duplicate session: ${name}`);
      state.set(name, [flag(args, "-n")]);
      return ok();
    }
    if (command === "new-window") {
      if (failNewWindow) return fail("create window failed: index in use");
      const windows = state.get(session(flag(args, "-t")));
      if (!windows) return fail("can't find session");
      windows.push(flag(args, "-n"));
      return ok();
    }
    return fail(`unknown command ${command}`);
  };
  return { tmux, calls, state };
}

const agent = (handle: string, projects: string[] | null): SavedAgent => ({
  token: `spt_${handle}`,
  actor: { name: handle, handle },
  projects: projects?.map((key) => ({ key, name: key })) ?? null,
  source: "invite",
  createdAt: "2026-01-01T00:00:00.000Z",
});

let homes: string[] = [];
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** Saved agents: three on ANT (prod), one on ST, an unscoped one, and an ANT agent on local sharing a handle. */
function savedAgents() {
  const home = mkdtempSync(join(tmpdir(), "spider-tmux-"));
  homes.push(home);
  const configDir = join(home, "config");
  mkdirSync(configDir);
  const store: Store = {
    version: 2,
    default: { server: "prod", org: "acme", agent: "st-dev" },
    servers: {
      prod: {
        url: "https://api.test",
        orgs: {
          acme: {
            name: "Acme",
            agents: {
              "ant-sales": agent("ant-sales", ["ANT"]),
              "ant-owner": agent("ant-owner", ["ANT", "ST"]),
              "ant-foreman": agent("ant-foreman", ["ANT"]),
              "st-dev": agent("st-dev", ["ST"]),
              helper: agent("helper", null),
            },
          },
        },
      },
      local: {
        url: "http://localhost:4000",
        orgs: {
          acme: {
            name: "Acme",
            agents: { "ant-sales": agent("ant-sales", ["ANT"]) },
          },
        },
      },
    },
  };
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify(store), {
    mode: 0o600,
  });
  return { HOME: home, SPIDER_CONFIG_DIR: configDir };
}

const self = ["/usr/local/bin/spider"];

async function cli(argv: string[], options: Partial<RunOptions> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: savedAgents(),
    cwd: "/work",
    self,
    spawn: async () => {
      throw new Error("--tmux must not start claude in this process");
    },
    git: () => {
      throw new Error("no git");
    },
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    ...options,
  });
  return { code, stdout, stderr };
}

describe("spider claude --tmux", () => {
  test("--all --project starts one window per project agent, named by handle, and a rerun adds none", async () => {
    const env = savedAgents();
    const { tmux, calls, state } = fakeTmux();
    const first = await cli(
      [
        "claude",
        "--all",
        "--project",
        "ant",
        "--server",
        "prod",
        "--tmux",
        "ant-agents",
      ],
      { env, tmux },
    );
    expect(first.code).toBe(0);
    expect(state.get("ant-agents")).toEqual([
      "ant-foreman",
      "ant-owner",
      "ant-sales",
    ]);
    const opened = calls.filter(
      (c) => c[0] === "new-session" || c[0] === "new-window",
    );
    expect(opened[0]).toEqual([
      "new-session",
      "-d",
      "-s",
      "ant-agents",
      "-n",
      "ant-foreman",
      "-c",
      "/work",
      "-e",
      `SPIDER_CONFIG_DIR=${env.SPIDER_CONFIG_DIR}`,
      "/usr/local/bin/spider claude prod/acme/ant-foreman",
    ]);
    expect(opened[1]?.slice(0, 6)).toEqual([
      "new-window",
      "-d",
      "-t",
      "=ant-agents:",
      "-n",
      "ant-owner",
    ]);
    expect(opened[2]?.at(-1)).toBe(
      "/usr/local/bin/spider claude prod/acme/ant-sales",
    );
    expect(first.stdout).toContain("tmux session ant-agents (created):");
    expect(first.stdout).toContain(
      "Started 3 of 3. Attach: tmux attach -t ant-agents",
    );
    expect(first.stderr).toContain("development-channels dialog");

    // Rerun: every window exists, nothing opens.
    const before = calls.length;
    const again = await cli(
      [
        "claude",
        "--all",
        "--project",
        "ANT",
        "--server",
        "prod",
        "--tmux",
        "ant-agents",
      ],
      { env, tmux },
    );
    expect(again.code).toBe(0);
    expect(
      calls
        .slice(before)
        .filter((c) => c[0] === "new-session" || c[0] === "new-window"),
    ).toEqual([]);
    expect(again.stdout).toContain(
      "skip   ant-sales    already running (window exists)",
    );
    expect(again.stdout).toContain("Started 0 of 3, 3 already running.");
    expect(state.get("ant-agents")).toHaveLength(3);
  });

  test("a list of agents: existing windows are skipped, options and claude arguments pass through, quoted", async () => {
    const { tmux, calls, state } = fakeTmux({
      sessions: { team: ["ant-owner", "zsh"] },
    });
    const result = await cli(
      [
        "claude",
        "ant-owner",
        "st-dev",
        "helper",
        "st-dev",
        "--tmux",
        "team",
        "--no-channel",
        "--permission-mode",
        "acceptEdits",
        "--",
        "--append-system-prompt",
        "it's me",
      ],
      { tmux },
    );
    expect(result.code).toBe(0);
    expect(state.get("team")).toEqual(["ant-owner", "zsh", "st-dev", "helper"]);
    const windows = calls.filter((c) => c[0] === "new-window");
    expect(windows).toHaveLength(2);
    expect(windows[0]?.at(-1)).toBe(
      `/usr/local/bin/spider claude prod/acme/st-dev --no-channel --permission-mode acceptEdits -- --append-system-prompt 'it'\\''s me'`,
    );
    expect(result.stdout).toContain(
      "skip   ant-owner  already running (window exists)",
    );
    expect(result.stdout).toContain("Started 2 of 3, 1 already running.");
    expect(result.stderr).not.toContain("development-channels");
  });

  test("a list of agents without --: the other agents never reach claude", async () => {
    const { tmux, calls, state } = fakeTmux();
    const result = await cli(
      ["claude", "ant-owner", "st-dev", "--tmux", "team"],
      { tmux },
    );
    expect(result.code).toBe(0);
    expect(state.get("team")).toEqual(["ant-owner", "st-dev"]);
    const commands = calls
      .filter((c) => c[0] === "new-session" || c[0] === "new-window")
      .map((c) => c.at(-1));
    expect(commands).toEqual([
      "/usr/local/bin/spider claude prod/acme/ant-owner",
      "/usr/local/bin/spider claude prod/acme/st-dev",
    ]);
  });

  test("--dry-run prints the plan and opens nothing", async () => {
    const { tmux, calls } = fakeTmux({ sessions: { team: ["ant-sales"] } });
    const result = await cli(
      [
        "claude",
        "--all",
        "--project",
        "ANT",
        "--server",
        "prod",
        "--tmux",
        "team",
        "--dry-run",
      ],
      { tmux },
    );
    expect(result.code).toBe(0);
    expect(calls.map((c) => c[0])).toEqual([
      "-V",
      "has-session",
      "list-windows",
    ]);
    expect(result.stdout).toBe(
      [
        "Plan for tmux session team:",
        "  start  ant-foreman  /usr/local/bin/spider claude prod/acme/ant-foreman",
        "  start  ant-owner    /usr/local/bin/spider claude prod/acme/ant-owner",
        "  skip   ant-sales    already running (window exists)",
        "Would start 2 of 3, 1 already running.",
        "",
      ].join("\n"),
    );

    // Without tmux the plan still prints, with a note.
    const missing = await cli(
      ["claude", "st-dev", "--tmux", "new", "--dry-run"],
      { tmux: fakeTmux({ missing: true }).tmux },
    );
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain(
      "Plan for tmux session new (would be created):",
    );
    expect(missing.stderr).toContain("tmux isn't installed");
  });

  test("without tmux it fails with a clear error", async () => {
    const result = await cli(["claude", "st-dev", "--tmux", "team"], {
      tmux: fakeTmux({ missing: true }).tmux,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "tmux isn't installed (or not on PATH). Install it (macOS: brew install tmux",
    );
  });

  test("usage errors: clashing handles, nothing to start, misplaced options, bad session names", async () => {
    const { tmux, calls } = fakeTmux();
    const expectUsage = async (argv: string[], message: string) => {
      const result = await cli(argv, { tmux });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(message);
    };
    // ant-sales is saved on prod and local: window names would clash.
    await expectUsage(
      ["claude", "--all", "--project", "ANT", "--tmux", "t"],
      "local/acme/ant-sales and prod/acme/ant-sales",
    );
    await expectUsage(
      ["claude", "--all", "--project", "NOPE", "--tmux", "t"],
      "No saved agents scoped to project NOPE",
    );
    await expectUsage(
      ["claude", "--project", "ANT", "--tmux", "t"],
      "--project goes with --all",
    );
    await expectUsage(
      ["claude", "st-dev", "--all", "--tmux", "t"],
      "Name agents or use --all, not both",
    );
    await expectUsage(["claude", "--tmux", "t"], "Which agents?");
    await expectUsage(
      ["claude", "st-dev", "--tmux", "a:b"],
      'Invalid tmux session name "a:b"',
    );
    for (const bad of ["=team", "$1", "%2"])
      await expectUsage(
        ["claude", "st-dev", "--tmux", bad],
        `Invalid tmux session name "${bad}"`,
      );
    await expectUsage(["claude", "--all"], "--all goes with --tmux <session>");
    await expectUsage(
      ["claude", "st-dev", "--dry-run"],
      "--dry-run goes with --tmux <session>",
    );
    await expectUsage(
      ["claude", "nobody", "--tmux", "t"],
      'No saved agent "nobody"',
    );
    await expectUsage(
      [
        "claude",
        "st-dev",
        "--tmux",
        "t",
        "--permission-mode",
        "auto",
        "--",
        "--permission-mode",
        "plan",
      ],
      "Give the permission mode once",
    );
    expect(calls).toEqual([]);
  });

  test("--as names the agent when none is given; a tmux failure is reported", async () => {
    const { tmux, state } = fakeTmux();
    expect(
      (await cli(["claude", "--as", "helper", "--tmux", "solo"], { tmux }))
        .code,
    ).toBe(0);
    expect(state.get("solo")).toEqual(["helper"]);

    const failing = fakeTmux({ sessions: { team: [] }, failNewWindow: true });
    const result = await cli(["claude", "st-dev", "--tmux", "team"], {
      tmux: failing.tmux,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "tmux new-window for st-dev failed: create window failed",
    );
  });
});

describe("tmux helpers", () => {
  test("shellQuote leaves plain words and quotes the rest", () => {
    expect(shellQuote("prod/acme/ant-sales")).toBe("prod/acme/ant-sales");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
    expect(
      windowCommand(["/Applications/My Tools/spider", "claude", "a;b"]),
    ).toBe("'/Applications/My Tools/spider' claude 'a;b'");
  });
});
