import { parseTaskKey } from "@repo/core/schemas";
import { z } from "zod";
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
    staging: [
      "railway",
      "up",
      "--service",
      "api",
      "--environment",
      "staging",
      "--detach",
    ],
  },
};

/** Files a deploy needs that aren't committed, by app and environment (relative to the root). */
export const DEPLOY_REQUIRES: Partial<
  Record<DeployApp, Record<string, string[]>>
> = {
  // Either one: Vite reads .env.staging and .env.staging.local in staging mode.
  web: { staging: ["web/app/.env.staging", "web/app/.env.staging.local"] },
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
  /**
   * Runs `spider <argv>` (the CLI's run) and resolves to its exit code; with `capture`, its stdout
   * is returned instead of printed (the preflight reads `release view --json`).
   */
  spider: (
    argv: string[],
    capture?: boolean,
  ) => Promise<{ code: number; stdout: string }>;
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
    const [name, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    if (known.includes(name)) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("-"))
        throw new UsageError(`${name} needs a value`);
      flags[name.slice(2)] = value.trim();
    } else if (arg.startsWith("-"))
      throw new UsageError(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const [app, ...rest] = positional;
  if (!app) throw new UsageError("Name the app to deploy: web or api");
  if (rest.length) throw new UsageError(`Unexpected argument ${rest[0]}`);
  if (!(DEPLOY_APPS as readonly string[]).includes(app))
    throw new UsageError(
      `Unknown app "${app}"; this script deploys ${DEPLOY_APPS.join(" and ")}`,
    );
  const release =
    flags.release === undefined ? undefined : parseTaskKey(flags.release);
  if (flags.release !== undefined && !release)
    throw new UsageError(
      `Invalid --release "${flags.release}". Expected a task key like ST-120`,
    );
  return {
    app: app as DeployApp,
    env: (flags.env ?? "prod").toLowerCase(),
    release: release ? `${release.projectKey}-${release.number}` : undefined,
    commit: flags.commit,
    as: flags.as,
  };
}

/** The part of `spider release view --json` the preflight reads. */
const releaseView = z.object({
  status: z.object({ category: z.string() }).optional(),
  // An older API without apps reads as none, so the deploy stops with "doesn't include the app".
  apps: z
    .array(
      z.object({
        name: z.string(),
        repo: z.string(),
        environments: z.array(z.string()),
      }),
    )
    .default([]),
});

/**
 * Before a deploy with --release (ST-142): reads the release (`spider release view <key> --json`) and
 * checks the app is in it with the environment among its environments, so bad credentials, a wrong
 * key or an app without that environment stop the deploy instead of leaving it unrecorded. Returns
 * the problem, or null.
 */
async function preflight(
  options: DeployOptions,
  args: DeployArgs & { release: string },
): Promise<string | null> {
  const view = await options.spider(
    [
      "release",
      "view",
      args.release,
      "--json",
      ...(args.as ? ["--as", args.as] : []),
    ],
    true,
  );
  if (view.code !== 0)
    return `Can't read release ${args.release} (spider exited ${view.code}); nothing deployed. Check the key and that you're signed in (--as <agent>)`;
  let json: unknown;
  try {
    json = JSON.parse(view.stdout);
  } catch {
    return `Can't read release ${args.release}: spider release view didn't answer JSON; nothing deployed`;
  }
  const parsed = releaseView.safeParse(json);
  if (!parsed.success)
    return `Can't read release ${args.release}: unexpected answer from spider release view (${parsed.error.issues[0]?.message ?? "invalid"}); nothing deployed`;
  const release = parsed.data;
  if (release.status?.category === "canceled")
    return `Release ${args.release} is canceled; nothing deployed`;
  const apps = release.apps.filter((a) => a.name === args.app);
  if (apps.length === 0)
    return `Release ${args.release} doesn't include the ${args.app} app; add it first (spider release update ${args.release} --app ${args.app}=<version>); nothing deployed`;
  // Two repos' apps with this name: which one this script deploys is ambiguous, so it stops.
  if (apps.length > 1)
    return `Release ${args.release} ships several ${args.app} apps (${apps.map((a) => a.repo).join(", ")}); this script deploys this repo's own, so record it with spider release deploy ${args.release} --app <owner/name>:${args.app} instead; nothing deployed`;
  const [app] = apps;
  if (!app?.environments.includes(args.env))
    return `The ${args.app} app has no "${args.env}" environment (${app?.environments.length ? app.environments.join(", ") : "none"}), so it can't be recorded on ${args.release}; nothing deployed`;
  return null;
}

/** Untracked files `railway up` would upload with the API (it uploads the working tree). */
function untrackedFiles(options: DeployOptions): string[] {
  const status = options.git(
    ["status", "--porcelain", "--untracked-files=normal"],
    options.cwd,
  );
  if (status.exitCode !== 0) return [];
  return status.stdout
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
}

/**
 * Deploys an app to an environment and, with --release, records the deployment on that release.
 * Exit codes: 0 deployed (and recorded), 2 usage or a failed preflight (nothing deployed), the
 * deploy's own code when it fails (nothing is recorded), 1 deployed but not recorded (the message
 * says how to record it by hand).
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
    stderr.write(
      `${args.app} has no "${args.env}" deploy; environments: ${Object.keys(DEPLOY_COMMANDS[args.app]).join(", ")}\n`,
    );
    return 2;
  }
  const required = DEPLOY_REQUIRES[args.app]?.[args.env];
  if (required && !required.some((path) => options.exists(path))) {
    stderr.write(
      `${required.join(" (or ")}${required.length > 1 ? ")" : ""} is missing: the ${args.env} build needs it. See "Staging" in docs/deployment.md\n`,
    );
    return 2;
  }

  if (args.release) {
    const problem = await preflight(options, {
      ...args,
      release: args.release,
    });
    if (problem) {
      stderr.write(`${problem}\n`);
      return 2;
    }
  }
  if (args.app === "api") {
    const untracked = untrackedFiles(options);
    if (untracked.length)
      stderr.write(
        `Warning: railway up uploads untracked files too (${untracked.length}: ${untracked.slice(0, 5).join(", ")}${untracked.length > 5 ? ", …" : ""}); commit, ignore or remove them\n`,
      );
  }

  // The commit is read before deploying, so it names what was built.
  let commit: string | undefined;
  if (args.release) {
    commit = args.commit;
    if (!commit) {
      const head = git(["rev-parse", "HEAD"], cwd);
      commit = head.exitCode === 0 ? head.stdout.trim() : "";
      if (!commit) {
        stderr.write(
          "Can't read HEAD to record the deployment; pass --commit <sha>\n",
        );
        return 2;
      }
      const dirty = git(["status", "--porcelain", "--untracked-files=no"], cwd);
      if (dirty.exitCode === 0 && dirty.stdout.trim()) {
        stderr.write(
          `Warning: uncommitted changes; the deployment is recorded at HEAD (${commit.slice(0, 7)}), which doesn't include them\n`,
        );
      }
    }
  }

  stdout.write(`Deploying ${args.app} to ${args.env}: ${command.join(" ")}\n`);
  const code = await options.spawn(command, cwd);
  if (code !== 0) {
    stderr.write(
      `The ${args.app} deploy failed (exit ${code})${args.release ? `; nothing recorded on ${args.release}` : ""}\n`,
    );
    return code;
  }
  if (!args.release || !commit) {
    stdout.write(
      `Deployed ${args.app} to ${args.env}. Not recorded on a release (add --release ST-NN to record it)\n`,
    );
    return 0;
  }

  const record = [
    "release",
    "deploy",
    args.release,
    "--app",
    args.app,
    "--env",
    args.env,
    "--commit",
    commit,
    ...(args.as ? ["--as", args.as] : []),
  ];
  const recorded = (await options.spider(record)).code;
  if (recorded !== 0) {
    stderr.write(
      `Deployed ${args.app} to ${args.env}, but couldn't record it on ${args.release}. Record it with:\n  bun run spider ${record.join(" ")}\n`,
    );
    return 1;
  }
  return 0;
}
