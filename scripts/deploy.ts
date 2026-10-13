#!/usr/bin/env bun
// The manual deploys (ST-94): runs the real deploy of web (Cloudflare Pages) or api (Railway) and,
// only when --release is given, records it on that tracker release with `spider release deploy`
// (signed in as --as / SPIDER_TOKEN / SPIDER_AGENT / the default saved agent). Without --release it
// deploys exactly as before. Nothing runs automatically: see docs/deployment.md.
//
//   bun run deploy:web                                    web to prod, records nothing
//   bun run deploy:web -- --release ST-120                web to prod, recorded on ST-120
//   bun run deploy:web -- --env staging --release ST-120  web to staging, recorded (Planned → On staging)
//   bun run deploy:api -- --env staging --release ST-120  the API to Railway's staging environment
//
// The logic and its tests are in backend/cli/src/deploy.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../backend/cli/src/cli";
import { deploy } from "../backend/cli/src/deploy";
import { runGit } from "../backend/cli/src/git";

const root = join(import.meta.dir, "..");

const code = await deploy({
  argv: process.argv.slice(2),
  cwd: root,
  spawn: async (cmd, cwd) =>
    Bun.spawn(cmd, {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    }).exited,
  git: runGit,
  spider: async (argv, capture) => {
    let captured = "";
    const code = await run(argv, {
      env: process.env,
      stdout: capture
        ? { write: (s: string) => ((captured += s), true) }
        : process.stdout,
      stderr: process.stderr,
      cwd: root,
    });
    return { code, stdout: captured };
  },
  exists: (path) => existsSync(join(root, path)),
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);
