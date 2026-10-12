import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PLUGIN_ID, writePluginManifests } from "./claude-agents";

// Installing Claude Code plugins through the `claude` CLI: the shared `spider-tracker` plugin
// (skill, MCP server, /spider-tracker:create-agent) and the private `spider-agents` plugin.

/** Runs `claude <args>`; undefined when Claude Code isn't installed. */
export type RunClaude = (
  args: string[],
) => Promise<{ exitCode: number; output: string } | undefined>;

export const SHARED_MARKETPLACE = "spider-tracker";
export const SHARED_PLUGIN_ID = "spider-tracker@spider-tracker";
export const DEFAULT_MARKETPLACE_SOURCE = "pipisasa/spider-tracker";
export const INSTALL_CLAUDE_HINT =
  "Claude Code is not installed (no `claude` on PATH). Install it with: curl -fsSL https://claude.ai/install.sh | bash";

export class ClaudeCommandError extends Error {}

/** Runs claude commands in order; false if Claude Code is missing, throws when one fails. */
async function runAll(
  runClaude: RunClaude,
  commands: string[][],
): Promise<boolean> {
  for (const args of commands) {
    const result = await runClaude(args);
    if (!result) return false;
    if (result.exitCode !== 0) {
      throw new ClaudeCommandError(
        `claude ${args.join(" ")} failed: ${result.output.trim() || `exit ${result.exitCode}`}`,
      );
    }
  }
  return true;
}

/** Adds the `spider-local` marketplace and installs `spider-agents` at user scope (both idempotent). */
export async function installAgentsPlugin(
  runClaude: RunClaude,
  root: string,
): Promise<boolean> {
  await writePluginManifests(root);
  return runAll(runClaude, [
    ["plugin", "marketplace", "add", root],
    ["plugin", "install", PLUGIN_ID, "--scope", "user"],
  ]);
}

/** SPIDER_PLUGIN_MARKETPLACE (a path, git URL or GitHub owner/repo), else this project's GitHub repo. */
export function marketplaceSource(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  const given = env.SPIDER_PLUGIN_MARKETPLACE?.trim();
  if (!given) return DEFAULT_MARKETPLACE_SOURCE;
  return isLocalPath(given)
    ? resolve(cwd, given.replace(/^~(?=\/|$)/, env.HOME ?? "~"))
    : given;
}

const isLocalPath = (source: string) =>
  /^(\.{1,2}(\/|$)|~(\/|$)|\/)/.test(source) || isAbsolute(source);

/** Installs the shared plugin at user scope; false if Claude Code is missing. */
export async function installSharedPlugin(
  runClaude: RunClaude,
  source: string,
): Promise<boolean> {
  return runAll(runClaude, [
    ["plugin", "marketplace", "add", source],
    ["plugin", "install", SHARED_PLUGIN_ID, "--scope", "user"],
  ]);
}

/** The `extraKnownMarketplaces` entry for a marketplace source. */
export function marketplaceEntry(source: string) {
  if (isAbsolute(source))
    return { source: { source: "directory", path: source } };
  if (/^(https?:|git@|ssh:)/.test(source))
    return { source: { source: "git", url: source } };
  return { source: { source: "github", repo: source } };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the marketplace and enables the shared plugin in <dir>/.claude/settings.json, keeping everything else. */
export async function writeProjectSettings(
  dir: string,
  source: string,
): Promise<string> {
  const path = join(dir, ".claude", "settings.json");
  const text = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    },
  );
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new ClaudeCommandError(
      `${path} is not valid JSON; fix it and run this again`,
    );
  }
  if (!isObject(settings))
    throw new ClaudeCommandError(`${path} is not a JSON object`);
  const marketplaces = isObject(settings.extraKnownMarketplaces)
    ? settings.extraKnownMarketplaces
    : {};
  const enabled = isObject(settings.enabledPlugins)
    ? settings.enabledPlugins
    : {};
  const next = {
    ...settings,
    extraKnownMarketplaces: {
      ...marketplaces,
      [SHARED_MARKETPLACE]: marketplaceEntry(source),
    },
    enabledPlugins: { ...enabled, [SHARED_PLUGIN_ID]: true },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}
