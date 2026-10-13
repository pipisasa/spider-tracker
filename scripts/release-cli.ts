#!/usr/bin/env bun
// Builds the spider CLI for every supported platform and publishes a GitHub release
// (`cli-v<version>`, marked latest, tagged at HEAD) with a SHA256SUMS file that
// web/app/public/install.sh downloads and verifies.
//
//   bun run release:cli                     build and upload (needs `gh auth login`)
//   bun run release:cli --dry-run           build only (binaries and SHA256SUMS)
//   bun run release:cli --release ST-120    use the cli section of release ST-120's changelog as
//                                           the release notes (`spider release notes ST-120 --app cli`;
//                                           ST-95); its cli version must match package.json

import { rmSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const dryRun = process.argv.includes("--dry-run");
const releaseFlag = process.argv.indexOf("--release");
const releaseKey = releaseFlag >= 0 ? process.argv[releaseFlag + 1] : undefined;
if (releaseFlag >= 0 && (!releaseKey || releaseKey.startsWith("-"))) {
  console.error(
    "--release needs the release's task key, e.g. --release ST-120",
  );
  process.exit(2);
}
const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

const pkg = (await Bun.file(join(root, "backend/cli/package.json")).json()) as {
  version: string;
};
const version = pkg.version;
const tag = `cli-v${version}`;
const outDir = join(root, "dist/release");

async function run(cmd: string[], quiet = false): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return proc.exited;
}

async function output(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    console.error(`${cmd.join(" ")} failed`);
    process.exit(1);
  }
  return text.trim();
}

const head = await output(["git", "rev-parse", "HEAD"]);

// The notes of the tracker release (ST-95): the cli section of its changelog, as the spider CLI
// prints it (signed in as SPIDER_AGENT / SPIDER_TOKEN / the default saved agent).
let changes = "";
if (releaseKey) {
  const notes = JSON.parse(
    await output([
      "bun",
      "backend/cli/src/index.ts",
      "release",
      "notes",
      releaseKey,
      "--app",
      "cli",
      "--json",
    ]),
  ) as { tag: string | null; markdown: string };
  if (notes.tag !== tag) {
    console.error(
      `${releaseKey} ships the cli as ${notes.tag ?? "nothing"}, but backend/cli/package.json is ${version} (${tag}). Fix one of them first.`,
    );
    process.exit(1);
  }
  changes = notes.markdown.trim();
  if (dryRun) console.log(`Release notes from ${releaseKey}:\n\n${changes}\n`);
}

if (!dryRun) {
  if ((await output(["git", "status", "--porcelain"])) !== "") {
    console.error(
      "The working tree has uncommitted changes. Commit or stash them first: the release is tagged at HEAD.",
    );
    process.exit(1);
  }
  // GitHub creates the tag at HEAD, so HEAD must already be pushed (as far as the last fetch knows).
  if ((await output(["git", "branch", "-r", "--contains", head])) === "") {
    console.error(
      `HEAD (${head.slice(0, 7)}) is not on any remote branch. Push it first (or run git fetch if it is).`,
    );
    process.exit(1);
  }
  if ((await run(["gh", "auth", "status"], true)) !== 0) {
    console.error("gh is not signed in. Run `gh auth login` first.");
    process.exit(1);
  }
  if ((await run(["gh", "release", "view", tag], true)) === 0) {
    console.error(
      `Release ${tag} already exists. Bump the version in backend/cli/package.json first.`,
    );
    process.exit(1);
  }
}

rmSync(outDir, { recursive: true, force: true });
const files: string[] = [];
for (const target of targets) {
  const outfile = join(outDir, `spider-${target}`);
  console.log(`Building ${tag} for ${target}`);
  const code = await run([
    "bun",
    "build",
    "--compile",
    "--minify",
    `--target=bun-${target}`,
    "backend/cli/src/index.ts",
    "--outfile",
    outfile,
  ]);
  if (code !== 0) {
    console.error(`Build failed for ${target}`);
    process.exit(1);
  }
  files.push(outfile);
}

const sums: string[] = [];
for (const file of files) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(file).arrayBuffer());
  sums.push(`${hasher.digest("hex")}  ${basename(file)}\n`);
}
const sumsFile = join(outDir, "SHA256SUMS");
await Bun.write(sumsFile, sums.join(""));
files.push(sumsFile);

if (dryRun) {
  console.log(
    `Dry run: built ${files.length - 1} binaries and SHA256SUMS in dist/release for ${head}; nothing uploaded.`,
  );
  process.exit(0);
}

const notes = [
  `spider CLI ${version}.`,
  "",
  ...(changes ? [changes, ""] : []),
  "Install or update:",
  "",
  "```sh",
  "curl -fsSL https://tracker.batele.plus/install.sh | sh",
  "```",
].join("\n");

const code = await run([
  "gh",
  "release",
  "create",
  tag,
  ...files,
  "--target",
  head,
  "--title",
  `spider CLI v${version}`,
  "--notes",
  notes,
  "--latest",
]);
if (code !== 0) process.exit(code);
console.log(`Published ${tag}.`);
if (releaseKey) {
  console.log(
    `Next: mark ${releaseKey} Released once every app it ships is out (bun run spider task done ${releaseKey}).`,
  );
}
