import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumOf, replaceBinary } from "./self-update";
import { binaryUrl } from "./update-check";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VERSION = "9.9.9";
const URL = binaryUrl(VERSION, "linux", "x64");
const SUMS_URL = URL.replace(/[^/]+$/, "SHA256SUMS");
const NEW_BINARY = `#!/bin/sh\necho ${VERSION}\n`;
const OLD_BINARY = "#!/bin/sh\necho 0.0.1\n";
const sha256 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** A temp dir holding the installed (old) binary. */
function installed() {
  const dir = mkdtempSync(join(tmpdir(), "spider-self-update-"));
  dirs.push(dir);
  const target = join(dir, "spider");
  writeFileSync(target, OLD_BINARY, { mode: 0o755 });
  return { dir, target };
}

/** Fake GitHub release: the binary, and SHA256SUMS unless `sums` is null. */
function release(sums: string | null) {
  const urls: string[] = [];
  const fetch = async (input: string) => {
    urls.push(input);
    if (input === URL) return new Response(NEW_BINARY);
    if (input === SUMS_URL && sums !== null) return new Response(sums);
    return new Response("Not Found", { status: 404 });
  };
  return { fetch, urls };
}

const replace = (
  target: string,
  fetch: (input: string) => Promise<Response>,
  warnings: string[] = [],
) =>
  replaceBinary(VERSION, fetch, {
    target,
    platform: "linux",
    arch: "x64",
    warn: (message) => warnings.push(message),
  });

test("checksumOf reads text and binary mode lines", () => {
  const hex = "a".repeat(64);
  expect(checksumOf(`${hex}  spider-linux-x64\n`, "spider-linux-x64")).toBe(hex);
  expect(checksumOf(`${hex} *spider-linux-x64\n`, "spider-linux-x64")).toBe(hex);
  expect(checksumOf(`${hex}  spider-linux-arm64\n`, "spider-linux-x64")).toBeUndefined();
});

test("a matching checksum replaces the binary", async () => {
  const { dir, target } = installed();
  const gh = release(
    `${"0".repeat(64)}  spider-darwin-arm64\n${sha256(NEW_BINARY)}  spider-linux-x64\n`,
  );
  const warnings: string[] = [];
  expect(await replace(target, gh.fetch, warnings)).toBe(target);
  expect(gh.urls).toEqual([URL, SUMS_URL]);
  expect(warnings).toEqual([]);
  expect(readFileSync(target, "utf8")).toBe(NEW_BINARY);
  expect(statSync(target).mode & 0o777).toBe(0o755);
  expect(readdirSync(dir)).toEqual(["spider"]);
});

test("a checksum mismatch fails and leaves the old binary", async () => {
  const { dir, target } = installed();
  const gh = release(`${sha256("something else")}  spider-linux-x64\n`);
  await expect(replace(target, gh.fetch)).rejects.toThrow(
    "Checksum mismatch for spider-linux-x64",
  );
  expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
  expect(readdirSync(dir)).toEqual(["spider"]);
});

test("an asset missing from SHA256SUMS fails and leaves the old binary", async () => {
  const { target } = installed();
  const gh = release(`${sha256(NEW_BINARY)}  spider-darwin-arm64\n`);
  await expect(replace(target, gh.fetch)).rejects.toThrow(
    "spider-linux-x64 is not listed",
  );
  expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
});

test("a release without SHA256SUMS warns and still replaces the binary", async () => {
  const { target } = installed();
  const warnings: string[] = [];
  expect(await replace(target, release(null).fetch, warnings)).toBe(target);
  expect(warnings).toEqual([
    `${SUMS_URL} not found; skipping checksum verification`,
  ]);
  expect(readFileSync(target, "utf8")).toBe(NEW_BINARY);
});

test("a binary that reports another version is not installed", async () => {
  const { dir, target } = installed();
  const fetch = async (input: string) =>
    input === URL
      ? new Response(OLD_BINARY)
      : new Response(`${sha256(OLD_BINARY)}  spider-linux-x64\n`);
  await expect(replace(target, fetch)).rejects.toThrow(
    `The downloaded spider reports "0.0.1", expected ${VERSION}`,
  );
  expect(readFileSync(target, "utf8")).toBe(OLD_BINARY);
  expect(readdirSync(dir)).toEqual(["spider"]);
});
