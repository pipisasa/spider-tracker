import type { FetchLike } from "@repo/sdk";
import { chmod, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { binaryUrl } from "./update-check";

/** True when running as a `bun build --compile` binary rather than from source. */
export const isCompiled = () =>
  Bun.main.startsWith("/$bunfs/") || /[\\/]~BUN[\\/]/.test(Bun.main);

/**
 * Replaces the running binary with release `version`: downloads it next to the binary, checks that
 * it reports `version`, then renames it over the old one (kept as .old until the swap succeeds).
 */
export async function replaceBinary(
  version: string,
  fetch: FetchLike,
): Promise<string> {
  const target = await realpath(process.execPath);
  const dir = dirname(target);
  const temp = join(
    dir,
    `.${basename(target)}-${version}-${process.pid}.download`,
  );
  const backup = `${target}.old`;
  const url = binaryUrl(version);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok)
      throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
    await Bun.write(temp, res);
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
    await rename(target, backup);
    try {
      await rename(temp, target);
    } catch (error) {
      await rename(backup, target);
      throw error;
    }
    await rm(backup, { force: true });
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
