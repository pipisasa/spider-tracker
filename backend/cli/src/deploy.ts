import { parseTaskKey } from "@repo/core/schemas";
import type { GitRunner } from "./git";
import type { Writer } from "./cli";

// The manual deploy scripts (ST-94): `bun run deploy:web` and `bun run deploy:api` run
// scripts/deploy.ts, which runs the real deploy and then, only when a release key is given,
// records it on that release with `spider release deploy`. Without --release it deploys exactly as
// before and records nothing. Everything that touches the outside world (the deploy, git, the
// spider CLI, the file system) is injected, so tests never deploy.

export const DEPLOY_APPS = ["web", "api"] as const;
export type DeployApp = (typeof DEPLOY_APPS)[number];

/** The real deploy of each app per environment, run from the repository root. */
export const DEPLOY_COMMANDS: Record<DeployApp, Record<string, string[]>> = {
  web: {
    // Cloudflare Pages: build with web/app/.env.production, upload to the production branch.
    prod: ["bun", "run", "--cwd", "web/app", "deploy"],
    // Build with web/app/.env.staging, upload to the Pages branch "staging" (docs/deployment.md#staging).
    staging: ["bun", "run", "--cwd", "web/app", "deploy:staging"],
  },
  api: {
    // Railway: upload the working tree to the api service (the API also deploys from GitHub on push).
    prod: ["railway", "up", "--service", "api", "--detach"],
    staging: ["railway", "up", "--service", "api", "--environment", "staging", "--detach"],
  },
};

/** Files a deploy needs that aren't committed, by app and environment (relative to the root). */
export const DEPLOY_REQUIRES: Partial<Record<DeployApp, Record<string, string>>> = {
  web: { staging: "web/app/.env.staging" },
};

export const DEPLOY_USAGE = `Usage: bun scripts/deploy.ts <web|api> [--env prod|staging] [--release ST-NN] [--commit <sha>] [--as <agent>]

  bun run deploy:web                                   deploy web to prod; records nothing
  bun run deploy:web -- --release ST-120               deploy web to prod, then record it on release ST-120
  bun run deploy:web -- --env staging --release ST-120 deploy web to staging and record it (moves a Planned release to On staging)
  bun run deploy:api -- --env staging --release ST-120 the same for the API on Railway

--commit defaults to HEAD; --as picks the saved agent that records it (as for spider --as).`;

export interface DeployOptions {
  /** Arguments after the script name. */
  argv: string[];
  /** The repository root: where the deploy runs and HEAD is read. */
  cwd: string;
  /** Runs the deploy command with inherited output; resolves to its exit code. */
  spawn: (cmd: string[], cwd: string) => Promise<number>;
  git: GitRunner;
  /** Runs `spider <argv>` (the CLI's run) and resolves to its exit code. */
  spider: (argv: string[]) => Promise<number>;
  /** Whether a file exists, relative to `cwd`. */
  exists: (path: string) => boolean;
  stdout: Writer;
  stderr: Writer;
}

interface DeployArgs {
  app: DeployApp;
  env: string;
  release?: string;
  commit?: string;
  as?: string;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): DeployArgs {
  // `bun run deploy:web -- --release ST-1` may pass the "--" through.
  const args = argv.filter((a) => a !== "--");
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const known = ["--env", "--release", "--commit", "--as"];
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (known.includes(name)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("-")) throw new UsageError(`${name} needs a value`);
      flags[name.slice(2)] = value.trim();
    } else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const [app, ...rest] = positional;
  if (!app) throw new UsageError("Name the app to deploy: web or api");
  if (rest.length) throw new UsageError(`Unexpected argument ${rest[0]}`);
  if (!(DEPLOY_APPS as readonly string[]).includes(app)) throw new UsageError(`Unknown app "${app}"; this script deploys ${DEPLOY_APPS.join(" and ")}`);
  const release = flags.release === undefined ? undefined : parseTaskKey(flags.release);
  if (flags.release !== undefined && !release) throw new UsageError(`Invalid --release "${flags.release}". Expected a task key like ST-120`);
  return {
    app: app as DeployApp,
    env: (flags.env ?? "prod").toLowerCase(),
    release: release ? `${release.projectKey}-${release.number}` : undefined,
    commit: flags.commit,
    as: flags.as,
  };
}

/**
 * Deploys an app to an environment and, with --release, records the deployment on that release.
 * Exit codes: 0 deployed (and recorded), 2 usage, the deploy's own code when it fails (nothing is
 * recorded), 1 deployed but not recorded (the message says how to record it by hand).
 */
export async function deploy(options: DeployOptions): Promise<number> {
  const { cwd, git, stdout, stderr } = options;
  let args: DeployArgs;
  try {
    args = parseArgs(options.argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`${err.message}\n\n${DEPLOY_USAGE}\n`);
    return 2;
  }
  const command = DEPLOY_COMMANDS[args.app][args.env];
  if (!command) {
    stderr.write(`${args.app} has no "${args.env}" deploy; environments: ${Object.keys(DEPLOY_COMMANDS[args.app]).join(", ")}\n`);
    return 2;
  }
  const required = DEPLOY_REQUIRES[args.app]?.[args.env];
  if (required && !options.exists(required)) {
    stderr.write(`${required} is missing: the ${args.env} build needs it. See "Staging" in docs/deployment.md\n`);
    return 2;
  }

  // The commit is read before deploying, so it names what was built.
  let commit: string | undefined;
  if (args.release) {
    commit = args.commit;
    if (!commit) {
      const head = git(["rev-parse", "HEAD"], cwd);
      commit = head.exitCode === 0 ? head.stdout.trim() : "";
      if (!commit) {
        stderr.write("Can't read HEAD to record the deployment; pass --commit <sha>\n");
        return 2;
      }
      const dirty = git(["status", "--porcelain", "--untracked-files=no"], cwd);
      if (dirty.exitCode === 0 && dirty.stdout.trim()) {
        stderr.write(`Warning: uncommitted changes; the deployment is recorded at HEAD (${commit.slice(0, 7)}), which doesn't include them\n`);
      }
    }
  }

  stdout.write(`Deploying ${args.app} to ${args.env}: ${command.join(" ")}\n`);
  const code = await options.spawn(command, cwd);
  if (code !== 0) {
    stderr.write(`The ${args.app} deploy failed (exit ${code})${args.release ? `; nothing recorded on ${args.release}` : ""}\n`);
    return code;
  }
  if (!args.release || !commit) {
    stdout.write(`Deployed ${args.app} to ${args.env}. Not recorded on a release (add --release ST-NN to record it)\n`);
    return 0;
  }

  const record = ["release", "deploy", args.release, "--app", args.app, "--env", args.env, "--commit", commit, ...(args.as ? ["--as", args.as] : [])];
  const recorded = await options.spider(record);
  if (recorded !== 0) {
    stderr.write(`Deployed ${args.app} to ${args.env}, but couldn't record it on ${args.release}. Record it with:\n  bun run spider ${record.join(" ")}\n`);
    return 1;
  }
  return 0;
}
