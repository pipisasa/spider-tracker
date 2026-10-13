import { afterAll, describe, expect, test } from "bun:test";
import { createApp as createApiApp } from "@repo/api/src/app";
import { createAuth } from "@repo/api/src/auth";
import { loadEnv } from "@repo/api/src/env";
import {
  createAgent,
  createApiKey,
  createApp,
  createOrganization,
  createProject,
  createRelease,
  createRepo,
  getRelease,
  type ActorContext,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { run } from "./cli";
import { deploy, type DeployOptions } from "./deploy";
import type { GitRunner } from "./git";

// scripts/deploy.ts (ST-94) with fake runners: nothing is deployed and no real git or tracker is touched.

const HEAD = "3f2c1ab9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8";

interface Fakes {
  spawned: { cmd: string[]; cwd: string }[];
  recorded: string[][];
  stdout: string;
  stderr: string;
}

function fakes(
  overrides: Partial<DeployOptions> & {
    deployCode?: number;
    recordCode?: number;
    dirty?: boolean;
    files?: string[];
  } = {},
) {
  const state: Fakes = { spawned: [], recorded: [], stdout: "", stderr: "" };
  const git: GitRunner = (args) => {
    if (args[0] === "rev-parse")
      return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (args[0] === "status")
      return {
        exitCode: 0,
        stdout: overrides.dirty ? " M web/app/src/main.tsx\n" : "",
        stderr: "",
      };
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  const options = (argv: string[]): DeployOptions => ({
    argv,
    cwd: "/repo",
    spawn: async (cmd, cwd) => {
      state.spawned.push({ cmd, cwd });
      return overrides.deployCode ?? 0;
    },
    git,
    spider: async (args) => {
      state.recorded.push(args);
      return overrides.recordCode ?? 0;
    },
    exists: (path) =>
      (overrides.files ?? ["web/app/.env.staging"]).includes(path),
    stdout: { write: (s: string) => (state.stdout += s) },
    stderr: { write: (s: string) => (state.stderr += s) },
    ...overrides,
  });
  return { state, options };
}

describe("scripts/deploy.ts (ST-94)", () => {
  test("without --release it deploys exactly as before and records nothing", async () => {
    const { state, options } = fakes();
    expect(await deploy(options(["web"]))).toBe(0);
    expect(state.spawned).toEqual([
      { cmd: ["bun", "run", "--cwd", "web/app", "deploy"], cwd: "/repo" },
    ]);
    expect(state.recorded).toEqual([]);
    expect(state.stdout).toContain(
      "Not recorded on a release (add --release ST-NN to record it)",
    );

    const api = fakes();
    expect(await deploy(api.options(["api"]))).toBe(0);
    expect(api.state.spawned[0]?.cmd).toEqual([
      "railway",
      "up",
      "--service",
      "api",
      "--detach",
    ]);
  });

  test("with --release it records the deploy at HEAD after it succeeds; a passed-through -- is ignored", async () => {
    const { state, options } = fakes();
    expect(
      await deploy(
        options([
          "web",
          "--",
          "--env",
          "staging",
          "--release",
          "st-120",
          "--as",
          "st-developer",
        ]),
      ),
    ).toBe(0);
    expect(state.spawned.map((s) => s.cmd)).toEqual([
      ["bun", "run", "--cwd", "web/app", "deploy:staging"],
    ]);
    expect(state.recorded).toEqual([
      [
        "release",
        "deploy",
        "ST-120",
        "--app",
        "web",
        "--env",
        "staging",
        "--commit",
        HEAD,
        "--as",
        "st-developer",
      ],
    ]);
    expect(state.stderr).toBe("");
  });

  test("--commit overrides HEAD; uncommitted changes only warn", async () => {
    const pinned = fakes();
    expect(
      await deploy(
        pinned.options([
          "api",
          "--env=staging",
          "--release",
          "ST-7",
          "--commit",
          "abc1234",
        ]),
      ),
    ).toBe(0);
    expect(pinned.state.spawned[0]?.cmd).toEqual([
      "railway",
      "up",
      "--service",
      "api",
      "--environment",
      "staging",
      "--detach",
    ]);
    expect(pinned.state.recorded[0]).toEqual([
      "release",
      "deploy",
      "ST-7",
      "--app",
      "api",
      "--env",
      "staging",
      "--commit",
      "abc1234",
    ]);

    const dirty = fakes({ dirty: true });
    expect(await deploy(dirty.options(["web", "--release", "ST-7"]))).toBe(0);
    expect(dirty.state.stderr).toContain(
      "Warning: uncommitted changes; the deployment is recorded at HEAD (3f2c1ab)",
    );
  });

  test("a failed deploy records nothing and keeps its exit code; a failed record says how to retry", async () => {
    const failed = fakes({ deployCode: 7 });
    expect(await deploy(failed.options(["web", "--release", "ST-7"]))).toBe(7);
    expect(failed.state.recorded).toEqual([]);
    expect(failed.state.stderr).toContain(
      "The web deploy failed (exit 7); nothing recorded on ST-7",
    );

    const unrecorded = fakes({ recordCode: 3 });
    expect(await deploy(unrecorded.options(["web", "--release", "ST-7"]))).toBe(
      1,
    );
    expect(unrecorded.state.stderr).toContain(
      `couldn't record it on ST-7. Record it with:\n  bun run spider release deploy ST-7 --app web --env prod --commit ${HEAD}`,
    );
  });

  test("usage errors deploy nothing: no app, an unknown app, option or environment, a bad key, a staging web build without its config", async () => {
    for (const [argv, message] of [
      [[], "Name the app to deploy"],
      [["docs"], 'Unknown app "docs"'],
      [["web", "--force"], "Unknown option --force"],
      [["web", "--release"], "--release needs a value"],
      [["web", "--release", "nope"], 'Invalid --release "nope"'],
      [
        ["web", "--env", "qa"],
        'web has no "qa" deploy; environments: prod, staging',
      ],
    ] as const) {
      const { state, options } = fakes();
      expect(await deploy(options([...argv]))).toBe(2);
      expect(state.stderr).toContain(message);
      expect(state.spawned).toEqual([]);
    }
    const noConfig = fakes({ files: [] });
    expect(await deploy(noConfig.options(["web", "--env", "staging"]))).toBe(2);
    expect(noConfig.state.stderr).toContain("web/app/.env.staging is missing");
    expect(noConfig.state.spawned).toEqual([]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDb = databaseUrl ? describe : describe.skip;

withDb("scripts/deploy.ts against the API (ST-94)", () => {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  });
  const db = createDb(env.DATABASE_URL);
  const api = createApiApp({
    db,
    auth: createAuth(db, env, { async sendMagicLink() {} }),
    env,
  });
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `deploy-${Date.now()}`;
  let owner: ActorContext;
  let releaseKey = "";

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("done when: deploying web to staging with the script records it on the release, and the release shows On staging", async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const org = await createOrganization(
      db,
      { id: userId, name: "Owner", email: "owner@example.com" },
      { name: "Deploy", slug },
    );
    owner = {
      orgId: org.organization.id,
      actorId: org.actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider Tracker", key: "ST" });
    await createRepo(db, owner, {
      url: "pipisasa/spider-tracker",
      projects: ["ST"],
    });
    await createApp(db, owner, "pipisasa/spider-tracker", {
      name: "web",
      path: "web/app",
      versioning: "date",
      environments: ["staging", "prod"],
    });
    const release = await createRelease(db, owner, "ST", {
      title: "2026.10.13",
      apps: [
        { repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.13" },
      ],
    });
    expect(release.status.name).toBe("Planned");
    releaseKey = release.key;
    const { actor } = await createAgent(db, owner, { name: "Release owner" });
    const key = await createApiKey(db, owner, actor.id, { name: "deploy" });

    // The real script's wiring, with the deploy, git and the network faked: the spider CLI runs in
    // process against the API app.
    const { state, options } = fakes();
    let cliOut = "";
    const code = await deploy({
      ...options(["web", "--env", "staging", "--release", release.key]),
      spider: (argv) =>
        run(argv, {
          env: { SPIDER_TOKEN: key.secret, SPIDER_API_URL: env.API_ORIGIN },
          fetch: (input, init) => api.request(input, init),
          stdout: { write: (s: string) => (cliOut += s) },
          stderr: { write: (s: string) => (cliOut += s) },
          cwd: "/repo",
        }),
    });
    expect(code).toBe(0);
    expect(state.spawned.map((s) => s.cmd)).toEqual([
      ["bun", "run", "--cwd", "web/app", "deploy:staging"],
    ]);
    expect(cliOut).toBe(
      `Recorded web → staging at 3f2c1ab for ${release.key} (2026.10.13)\n${release.key} moved Planned → On staging\n`,
    );

    const after = await getRelease(db, owner, release.key);
    expect(after.status.name).toBe("On staging");
    expect(after.deployments).toEqual([
      expect.objectContaining({
        app: "web",
        environment: "staging",
        production: false,
        commitSha: HEAD,
        source: "cli",
        deployedBy: expect.objectContaining({ id: actor.id }),
      }),
    ]);
  });

  test("spider release deploy without --commit records HEAD through the injected git runner", async () => {
    const key = await createApiKey(
      db,
      owner,
      (await createAgent(db, owner, { name: "Second" })).actor.id,
      { name: "deploy" },
    );
    let out = "";
    let gitCalls: string[][] = [];
    const code = await run(
      [
        "release",
        "deploy",
        releaseKey,
        "--app",
        "web",
        "--env",
        "prod",
        "--json",
      ],
      {
        env: { SPIDER_TOKEN: key.secret, SPIDER_API_URL: env.API_ORIGIN },
        fetch: (input, init) => api.request(input, init),
        stdout: { write: (s: string) => (out += s) },
        stderr: { write: (s: string) => (out += s) },
        cwd: "/repo",
        git: (args) => {
          gitCalls = [...gitCalls, args];
          return { exitCode: 0, stdout: "abcdef1234567\n", stderr: "" };
        },
      },
    );
    expect(code).toBe(0);
    expect(gitCalls).toEqual([["rev-parse", "HEAD"]]);
    const parsed = JSON.parse(out) as {
      deployment: { commitSha: string; production: boolean };
      release: { status: { name: string }; deployments: unknown[] };
      movedFrom: unknown;
    };
    expect(parsed).toMatchObject({
      deployment: { commitSha: "abcdef1234567", production: true },
      release: { status: { name: "On staging" } },
      movedFrom: null,
    });
    expect(parsed.release.deployments).toHaveLength(2);

    // Outside a clone, without --commit: a usage error.
    let err = "";
    const outside = await run(
      ["release", "deploy", releaseKey, "--app", "web", "--env", "prod"],
      {
        env: { SPIDER_TOKEN: key.secret, SPIDER_API_URL: env.API_ORIGIN },
        fetch: (input, init) => api.request(input, init),
        stdout: { write: () => undefined },
        stderr: { write: (s: string) => (err += s) },
        cwd: "/repo",
        git: () => ({
          exitCode: 128,
          stdout: "",
          stderr: "not a git repository",
        }),
      },
    );
    expect(outside).toBe(2);
    expect(err).toContain(
      "No commit to record: run it in the clone you deployed from, or pass --commit <sha>",
    );

    let listed = "";
    await run(["release", "deployments", releaseKey, "--env", "prod"], {
      env: { SPIDER_TOKEN: key.secret, SPIDER_API_URL: env.API_ORIGIN },
      fetch: (input, init) => api.request(input, init),
      stdout: { write: (s: string) => (listed += s) },
      stderr: { write: () => undefined },
      cwd: "/repo",
    });
    expect(listed).toMatch(
      /^web {2}prod {2}abcdef1 {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}@second\n$/,
    );
  });
});
