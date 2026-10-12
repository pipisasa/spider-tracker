import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokenHooks, claudeCommand, hookScripts, permissionLine, permissionModeFor } from "./claude-launch";

describe("permissionModeFor", () => {
  test("the option, then claude's arguments, then the saved agent, then auto", () => {
    expect(permissionModeFor("plan", ["--permission-mode", "manual"], "acceptEdits")).toEqual({ mode: "plan", source: "option" });
    expect(permissionModeFor(undefined, ["--permission-mode", "manual"], "acceptEdits")).toEqual({ mode: "manual", source: "claude-args" });
    expect(permissionModeFor(undefined, ["--permission-mode=dontAsk"], undefined)).toEqual({ mode: "dontAsk", source: "claude-args" });
    expect(permissionModeFor(undefined, ["--dangerously-skip-permissions"], "manual")).toEqual({ mode: null, source: "claude-args" });
    expect(permissionModeFor(undefined, ["--model", "opus"], "acceptEdits")).toEqual({ mode: "acceptEdits", source: "agent" });
    expect(permissionModeFor(undefined, [], undefined)).toEqual({ mode: "auto", source: "default" });
  });

  test("the startup line names the mode and where it came from", () => {
    expect(permissionLine({ mode: "auto", source: "default" })).toBe("Permission mode: auto (spider default)");
    expect(permissionLine({ mode: "manual", source: "agent" })).toBe("Permission mode: manual (saved for this agent)");
    expect(permissionLine({ mode: null, source: "claude-args" })).toBe("Permission mode: bypassPermissions (--dangerously-skip-permissions)");
  });
});

describe("claudeCommand", () => {
  const base = { mcpConfig: "/tmp/x/mcp.json", channel: true, permission: { mode: "auto", source: "default" as const } };

  test("claude arguments, the mode, the agent, then the MCP config and the channel", () => {
    expect(claudeCommand({ ...base, claudeArgs: ["--model", "opus"], agent: "spider-agents:prod:acme:dev" })).toEqual([
      "claude",
      "--model",
      "opus",
      "--permission-mode",
      "auto",
      "--agent",
      "spider-agents:prod:acme:dev",
      "--mcp-config",
      "/tmp/x/mcp.json",
      "--dangerously-load-development-channels",
      "server:spider-channel",
    ]);
  });

  test("no channel, no agent; a mode from claude's arguments isn't repeated", () => {
    expect(
      claudeCommand({ ...base, channel: false, claudeArgs: ["--permission-mode", "plan"], permission: { mode: "plan", source: "claude-args" } }),
    ).toEqual(["claude", "--permission-mode", "plan", "--mcp-config", "/tmp/x/mcp.json"]);
    expect(
      claudeCommand({ ...base, channel: false, claudeArgs: ["--dangerously-skip-permissions"], permission: { mode: null, source: "claude-args" } }),
    ).toEqual(["claude", "--dangerously-skip-permissions", "--mcp-config", "/tmp/x/mcp.json"]);
  });
});

describe("hooks", () => {
  test("hookScripts finds the scripts a command runs by path", () => {
    const env = { HOME: "/home/me" };
    expect(hookScripts('node "/home/me/.claude/hooks/gsd-check-update.js"', env)).toEqual(["/home/me/.claude/hooks/gsd-check-update.js"]);
    expect(hookScripts("bash ~/hooks/a.sh && $HOME/b.py", env)).toEqual(["/home/me/hooks/a.sh", "/home/me/b.py"]);
    expect(hookScripts("command -v spider >/dev/null 2>&1 && spider update --check --hook || true", env)).toEqual([]);
    expect(hookScripts("node relative/hook.js", env)).toEqual([]);
  });

  test("brokenHooks reports hooks in user and project settings whose script is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "spider-hooks-"));
    const project = join(home, "repo");
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(project, ".claude"), { recursive: true });
      writeFileSync(join(home, "ok.sh"), "");
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "node ~/gone.js" }, { type: "command", command: "~/ok.sh" }] }],
            Stop: "not a list",
          },
        }),
      );
      writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/nope/check.py" }] }] } }));
      writeFileSync(join(project, ".claude", "settings.json"), "{ not json");
      expect(await brokenHooks({ HOME: home }, project)).toEqual([
        { settings: join(home, ".claude", "settings.json"), event: "SessionStart", command: "node ~/gone.js", missing: join(home, "gone.js") },
        { settings: join(project, ".claude", "settings.local.json"), event: "PreToolUse", command: "/nope/check.py", missing: "/nope/check.py" },
      ]);
      // CLAUDE_CONFIG_DIR replaces ~/.claude.
      expect(await brokenHooks({ HOME: home, CLAUDE_CONFIG_DIR: join(home, "elsewhere") }, undefined)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
