import type { FetchLike } from "@repo/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentFileRefresh } from "./claude-agents";
import { SHARED_PLUGIN_ID, type RunClaude } from "./claude-setup";
import {
  checkForUpdates,
  isFresh,
  readUpdateCache,
  type UpdateInfo,
} from "./update-check";
import { CLI_VERSION, isNewer } from "./version";

// What `spider update` and the passive "a new spider is available" notice share.

type Env = Record<string, string | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A plugin entry's version, preferring the user-scope install. */
function versionOf(entries: unknown): string | null {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(isRecord);
  const entry = list.find((e) => e.scope === "user") ?? list[0];
  return entry && typeof entry.version === "string" ? entry.version : null;
}

/**
 * The installed shared plugin's version (null when not installed): from `claude plugin list
 * --json` when `runClaude` is given, else (or when that fails) Claude Code's installed_plugins.json.
 */
export async function installedPluginVersion(
  env: Env,
  runClaude?: RunClaude,
): Promise<string | null> {
  const listed = await runClaude?.(["plugin", "list", "--json"]).catch(
    () => undefined,
  );
  if (listed?.exitCode === 0) {
    try {
      const plugins: unknown = JSON.parse(listed.output);
      if (Array.isArray(plugins))
        return versionOf(
          plugins.filter((p) => isRecord(p) && p.id === SHARED_PLUGIN_ID),
        );
    } catch {
      // Fall back to the file.
    }
  }
  const dir =
    env.CLAUDE_CONFIG_DIR?.trim() || (env.HOME && join(env.HOME, ".claude"));
  if (!dir) return null;
  try {
    const file: unknown = JSON.parse(
      await readFile(join(dir, "plugins", "installed_plugins.json"), "utf8"),
    );
    const plugins =
      isRecord(file) && isRecord(file.plugins) ? file.plugins : {};
    const entries = plugins[SHARED_PLUGIN_ID];
    return entries === undefined ? null : versionOf(entries);
  } catch {
    return null;
  }
}

export interface UpdateReport {
  checkedAt: string;
  cli: { current: string; latest: string | null; outdated: boolean };
  plugin: {
    id: string;
    installed: string | null;
    latest: string | null;
    outdated: boolean;
  };
  agents: {
    path: string;
    agent: string;
    state: AgentFileRefresh["state"];
    version: string | null;
  }[];
}

export function updateReport(
  info: UpdateInfo,
  installed: string | null,
  agents: AgentFileRefresh[],
): UpdateReport {
  return {
    checkedAt: info.checkedAt,
    cli: {
      current: CLI_VERSION,
      latest: info.cli,
      outdated: isNewer(info.cli, CLI_VERSION),
    },
    plugin: {
      id: SHARED_PLUGIN_ID,
      installed,
      latest: info.plugin,
      outdated: installed !== null && isNewer(info.plugin, installed),
    },
    agents: agents.map((a) => ({
      path: a.path,
      agent: a.spider,
      state: a.state,
      version: a.version,
    })),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The SessionStart context note, or undefined when everything is current. */
export function hookNote(report: UpdateReport): string | undefined {
  const parts: string[] = [];
  if (report.cli.outdated)
    parts.push(
      `the spider CLI ${report.cli.current} is out of date (latest ${report.cli.latest})`,
    );
  if (report.plugin.outdated) {
    parts.push(
      `the spider-tracker plugin ${report.plugin.installed} is out of date (latest ${report.plugin.latest})`,
    );
  }
  const stale = report.agents.filter((a) => a.state === "outdated").length;
  if (stale)
    parts.push(
      `${plural(stale, "agent file")} from an older spider need refreshing`,
    );
  if (!parts.length) return undefined;
  const list =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
      : parts[0];
  return `Spider Tracker: ${list}. Tell the user and offer to run \`spider update\` (then restart Claude Code).`;
}

/** The hook's stdout for Claude Code: SessionStart additional context. */
export const hookOutput = (note: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: note,
    },
  });

export const noticeLine = (latest: string) =>
  `A new spider is available: ${CLI_VERSION} → ${latest}. Run: spider update\n`;

/** Commands that never show the passive notice (machine output, long-running or the updater itself). */
// uninstall deletes the config folder the update cache lives in.
const QUIET_COMMANDS = new Set(["mcp-headers", "channel", "update", "claude", "uninstall"]);
const GLOBAL_WITH_VALUE = new Set(["--as", "--server"]);

/** The top-level command in argv, skipping global options. */
export function commandOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") return undefined;
    if (GLOBAL_WITH_VALUE.has(arg)) i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/** Whether this run may print the passive notice at all (a person at a terminal, not opted out). */
export function noticeAllowed(
  argv: string[],
  env: Env,
  interactive: boolean | undefined,
) {
  if (!interactive || env.SPIDER_NO_UPDATE_CHECK?.trim() || env.CI?.trim())
    return false;
  return !argv.some(
    (a) =>
      a === "--json" ||
      a === "-h" ||
      a === "--help" ||
      a === "-V" ||
      a === "--version",
  );
}

export const passiveNoticeFor = (argv: string[]) => {
  const command = commandOf(argv);
  return (
    command !== undefined && command !== "help" && !QUIET_COMMANDS.has(command)
  );
};

/**
 * Starts the passive check: the cache, refreshed in the background when stale. The returned
 * function waits at most `waitMs` more for the refresh, then prints the notice if there is a newer CLI.
 */
export function startNotice(
  env: Env,
  fetch: FetchLike,
  write: (line: string) => unknown,
  waitMs = 300,
) {
  const controller = new AbortController();
  const cached = readUpdateCache(env);
  const refreshed = cached.then((info) =>
    info && isFresh(info)
      ? info
      : checkForUpdates(env, fetch, {
          force: true,
          timeoutMs: 2000,
          signal: controller.signal,
        }),
  );
  refreshed.catch(() => {});
  return async () => {
    let stop = () => {};
    const timeout = new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      stop = () => clearTimeout(timer);
    });
    const info =
      (await Promise.race([refreshed.catch(() => undefined), timeout])) ??
      (await cached);
    stop();
    controller.abort();
    if (info && isNewer(info.cli, CLI_VERSION))
      write(noticeLine(info.cli ?? ""));
  };
}
