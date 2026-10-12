import type { FetchLike } from "@repo/sdk";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./credentials";
import { parseVersion } from "./version";

// The latest spider CLI (GitHub releases tagged cli-v<version>) and shared Claude Code plugin
// (plugin.json on main), cached for a day in <configDir>/update-check.json.

type Env = Record<string, string | undefined>;

export const REPO = "pipisasa/spider-tracker";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
export const PLUGIN_MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/plugins/spider-tracker/.claude-plugin/plugin.json`;
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** The release asset for this machine, e.g. spider-darwin-arm64. */
export const binaryUrl = (
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
) =>
  `https://github.com/${REPO}/releases/download/cli-v${version}/spider-${platform}-${arch}`;

export interface UpdateInfo {
  /** ISO time of the last check. */
  checkedAt: string;
  /** Latest CLI release; null when unknown. */
  cli: string | null;
  /** Latest shared plugin version; null when unknown. */
  plugin: string | null;
}

const cacheFile = (env: Env) => {
  const dir = configDir(env);
  return dir && join(dir, "update-check.json");
};

export async function readUpdateCache(
  env: Env,
): Promise<UpdateInfo | undefined> {
  const path = cacheFile(env);
  if (!path) return undefined;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { checkedAt, cli, plugin } = value as Record<string, unknown>;
    if (typeof checkedAt !== "string") return undefined;
    return {
      checkedAt,
      cli: typeof cli === "string" ? cli : null,
      plugin: typeof plugin === "string" ? plugin : null,
    };
  } catch {
    return undefined;
  }
}

async function writeUpdateCache(env: Env, info: UpdateInfo) {
  const path = cacheFile(env);
  const dir = configDir(env);
  if (!path || !dir) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export const isFresh = (info: UpdateInfo, now = Date.now()) => {
  const at = Date.parse(info.checkedAt);
  return Number.isFinite(at) && now - at < CHECK_TTL_MS && at <= now;
};

const versionOfTag = (tag: unknown) =>
  typeof tag === "string" && tag.startsWith("cli-v") && parseVersion(tag)
    ? tag.slice("cli-v".length)
    : null;

async function getJson(
  fetch: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "spider-cli",
    },
    signal,
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The newest cli-v* release: the latest release, else the newest cli-v* one in the list. */
async function latestCli(
  fetch: FetchLike,
  signal: AbortSignal,
): Promise<string | null> {
  const latest = await getJson(fetch, `${RELEASES_API}/latest`, signal).catch(
    () => null,
  );
  const fromLatest = versionOfTag(
    isRecord(latest) ? latest.tag_name : undefined,
  );
  if (fromLatest) return fromLatest;
  const list = await getJson(fetch, `${RELEASES_API}?per_page=30`, signal);
  if (!Array.isArray(list)) return null;
  for (const release of list) {
    if (
      isRecord(release) &&
      release.draft !== true &&
      release.prerelease !== true
    ) {
      const version = versionOfTag(release.tag_name);
      if (version) return version;
    }
  }
  return null;
}

async function latestPlugin(
  fetch: FetchLike,
  signal: AbortSignal,
): Promise<string | null> {
  const manifest = await getJson(fetch, PLUGIN_MANIFEST_URL, signal);
  return isRecord(manifest) && typeof manifest.version === "string"
    ? manifest.version
    : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface CheckOptions {
  /** Ignore the cache's age. */
  force?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: number;
}

/**
 * The cached result while it is fresh, else a new check (saved to the cache). A failed lookup
 * keeps the previously known version; the cache is still stamped so offline runs don't retry
 * every time.
 */
export async function checkForUpdates(
  env: Env,
  fetch: FetchLike,
  options: CheckOptions = {},
): Promise<UpdateInfo> {
  const now = options.now ?? Date.now();
  const cached = await readUpdateCache(env);
  if (cached && !options.force && isFresh(cached, now)) return cached;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 3000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const [cli, plugin] = await Promise.all([
    latestCli(fetch, signal).catch(() => null),
    latestPlugin(fetch, signal).catch(() => null),
  ]);
  if (options.signal?.aborted)
    return (
      cached ?? {
        checkedAt: new Date(0).toISOString(),
        cli: null,
        plugin: null,
      }
    );
  const info: UpdateInfo = {
    checkedAt: new Date(now).toISOString(),
    cli: cli ?? cached?.cli ?? null,
    plugin: plugin ?? cached?.plugin ?? null,
  };
  await writeUpdateCache(env, info).catch(() => {});
  return info;
}
