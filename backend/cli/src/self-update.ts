import type { FetchLike } from "@repo/sdk";
import { chmod, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { binaryUrl } from "./update-check";
import { compareVersions } from "./version";

const FIRST_VERSION_WITH_SUMS = "0.1.3";

/** True when running as a `bun build --compile` binary rather than from source. */
export const isCompiled = () =>
  Bun.main.startsWith("/$bunfs/") || /[\\/]~BUN[\\/]/.test(Bun.main);

export interface ReplaceBinaryOptions {
  /** The binary to replace; defaults to the running one. */
  target?: string;
  platform?: string;
  arch?: string;
  /** Called for a non-fatal problem (a release without SHA256SUMS). */
  warn?: (message: string) => void;
}

/** The sha256 SHA256SUMS lists for `asset` (`<hex>  <name>` or `<hex> *<name>` lines). */
export function checksumOf(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === asset) return match[1]?.toLowerCase();
  }
  return undefined;
}

/**
 * Replaces the binary with release `version`: downloads it, verifies it against the release's
 * SHA256SUMS, writes it next to the binary, checks that it reports `version`, then renames it over
 * the old one in one step. Returns the replaced binary's path.
 */
export async function replaceBinary(
  version: string,
  fetch: FetchLike,
  options: ReplaceBinaryOptions = {},
): Promise<string> {
  const target = options.target ?? (await realpath(process.execPath));
  const dir = dirname(target);
  const temp = join(
    dir,
    `.${basename(target)}-${version}-${process.pid}.download`,
  );
  const url = binaryUrl(version, options.platform, options.arch);
  const asset = basename(url);
  const sumsUrl = `${dirname(url)}/SHA256SUMS`;
  const get = (from: string) =>
    fetch(from, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
  try {
    const res = await get(url);
    if (!res.ok)
      throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();

    // Releases before cli-v0.1.3 have no SHA256SUMS; from 0.1.3 on a missing file means a broken
    // or tampered release, so it is an error.
    const sumsRes = await get(sumsUrl);
    if (sumsRes.status === 404 && compareVersions(version, FIRST_VERSION_WITH_SUMS) >= 0) {
      throw new Error(`${sumsUrl} is missing; refusing to install an unverified binary`);
    }
    if (sumsRes.status === 404) {
      options.warn?.(`${sumsUrl} not found; skipping checksum verification`);
    } else {
      if (!sumsRes.ok)
        throw new Error(`Download failed: ${sumsUrl} (HTTP ${sumsRes.status})`);
      const expected = checksumOf(await sumsRes.text(), asset);
      if (!expected) throw new Error(`${asset} is not listed in ${sumsUrl}`);
      const actual = new Bun.CryptoHasher("sha256")
        .update(bytes)
        .digest("hex");
      if (actual !== expected)
        throw new Error(
          `Checksum mismatch for ${asset} (expected ${expected}, got ${actual})`,
        );
    }

    await Bun.write(temp, bytes);
    await chmod(temp, 0o755);
    if (process.platform === "darwin") {
      Bun.spawnSync(["xattr", "-d", "com.apple.quarantine", temp], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    const check = Bun.spawnSync([temp, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 15_000,
    });
    const reported = check.stdout.toString().trim();
    if (check.exitCode !== 0 || reported !== version) {
      throw new Error(
        `The downloaded spider reports "${reported || `exit ${check.exitCode}`}", expected ${version}`,
      );
    }
    await rename(temp, target);
    return target;
  } catch (error) {
    await rm(temp, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `Can't write to ${dir}. Reinstall instead: curl -fsSL https://tracker.batele.plus/install.sh | sh`,
      );
    }
    throw error;
  }
}
