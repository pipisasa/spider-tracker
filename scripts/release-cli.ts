#!/usr/bin/env bun
// Builds the spider CLI for every supported platform and publishes a GitHub release
// (`cli-v<version>`, marked latest) that web/app/public/install.sh downloads from.
//
//   bun run release:cli            build and upload (needs `gh auth login`)
//   bun run release:cli --dry-run  build only

import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dryRun = process.argv.includes("--dry-run");
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

if (!dryRun) {
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

if (dryRun) {
  console.log(
    `Dry run: built ${files.length} binaries in dist/release; nothing uploaded.`,
  );
  process.exit(0);
}

const notes = [
  `spider CLI ${version}.`,
  "",
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
  "--title",
  `spider CLI v${version}`,
  "--notes",
  notes,
  "--latest",
]);
if (code !== 0) process.exit(code);
console.log(`Published ${tag}.`);
