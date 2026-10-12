import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "@repo/api/src/app";
import { createAuth } from "@repo/api/src/auth";
import { loadEnv } from "@repo/api/src/env";
import { createAgent, createApiKey, createOrganization, createProject, createTask, getProject, updateTask, type ActorContext } from "@repo/core";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { createClient } from "@repo/sdk";
import { ROADMAP_PHASES, importReportLines, importRoadmap, phaseTitle } from "./roadmap-import";

describe("the roadmap phases (ST-96)", () => {
  test("Phases 0–7 in order, each with a goal; every task listed once", () => {
    expect(ROADMAP_PHASES.map((p) => p.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const phase of ROADMAP_PHASES) expect(phase.body).toStartWith("**Goal:** ");
    const keys = ROADMAP_PHASES.flatMap((p) => p.tasks);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => /^ST-\d+$/.test(k))).toBe(true);
    expect(ROADMAP_PHASES.find((p) => p.number === 4)?.tasks).toEqual(["ST-19"]);
    expect(phaseTitle(ROADMAP_PHASES[4]!)).toBe("Phase 4: Git and GitHub");
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDb = databaseUrl ? describe : describe.skip;

withDb("roadmap import against the API (ST-96)", () => {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  });
  const db = createDb(env.DATABASE_URL);
  const app = createApp({ db, auth: createAuth(db, env, { async sendMagicLink() {} }), env });
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `roadmap-${Date.now()}`;

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("creates Phases 0–7 with their tasks (Phase 4 lists the GitHub sub-tasks), then changes nothing on a second run", async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const org = await createOrganization(db, { id: userId, name: "Owner", email: "owner@example.com" }, { name: "Roadmap", slug });
    const owner: ActorContext = { orgId: org.organization.id, actorId: org.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider Tracker", key: "ST" });
    // ST-1 … ST-125 as on prod: ST-81–ST-88 and ST-99 are sub-tasks of ST-19, ST-27 of ST-21; ST-1–ST-20 are Done.
    const done = (await getProject(db, owner, "ST")).workflows.task.find((s) => s.category === "done")!.id;
    const ids = new Map<number, string>();
    const parents: Record<number, number> = { 27: 21, 81: 19, 82: 19, 83: 19, 84: 19, 85: 19, 86: 19, 87: 19, 88: 19, 99: 19 };
    for (let n = 1; n <= 125; n++) {
      const parent = parents[n];
      const task = await createTask(db, owner, "ST", {
        title: n === 19 ? "GitHub App integration" : n >= 81 && n <= 87 ? `GitHub 19${String.fromCharCode(97 + n - 81)}` : `Task ${n}`,
        statusId: n <= 18 ? done : undefined,
        parentId: parent ? ids.get(parent) : undefined,
      });
      ids.set(n, task.id);
    }
    // A milestone a person made earlier for ST-22 stays theirs.
    const { actor } = await createAgent(db, owner, { name: "Importer" });
    const key = await createApiKey(db, owner, actor.id, { name: "import" });
    const client = createClient({ baseUrl: env.API_ORIGIN, token: key.secret, source: "cli", fetch: (input, init) => app.request(input, init) });
    const custom = await client.milestones.create(slug, "ST", { title: "Fields" });
    await updateTask(db, owner, "ST-22", { milestoneId: custom.id });

    const preview = await importRoadmap(client, slug, { project: "st", dryRun: true });
    expect(preview.outcomes.filter((o) => o.kind === "milestone").map((o): string => o.action)).toEqual(Array<string>(8).fill("would create"));
    expect((await client.milestones.list(slug, "ST")).items).toHaveLength(1);
    expect(importReportLines(preview)).toContain("Dry run: 8 milestones to create, 32 tasks to assign.");

    const report = await importRoadmap(client, slug, { project: "ST", dryRun: false });
    expect(report.outcomes).toContainEqual({ kind: "task", phase: 6, key: "ST-22", action: "in another milestone", detail: custom.key });
    expect(importReportLines(report)).toContain("Done: 8 milestones created, 32 tasks assigned");

    const roadmap = (await client.milestones.list(slug, "ST")).items.filter((m) => m.title.startsWith("Phase"));
    expect(roadmap.map((m) => [m.title, m.status.name])).toEqual([
      ["Phase 0: Foundations and deployment", "Done"],
      ["Phase 1: Core tracker basics", "Done"],
      ["Phase 2: Agent access", "Active"],
      ["Phase 3: Tracker features", "Active"],
      ["Phase 4: Git and GitHub", "Active"],
      ["Phase 5: Hosted agents", "Planned"],
      ["Phase 6: Documents, custom fields and apps", "Planned"],
      ["Phase 7: Polish and opening up", "Planned"],
    ]);
    const phase4 = roadmap[4]!;
    expect(phase4.description).toContain("**Done when:** opening and merging a pull request");
    expect(phase4.tasks.map((t) => [t.key, t.inherited])).toEqual([
      ["ST-19", false],
      ...["ST-81", "ST-82", "ST-83", "ST-84", "ST-85", "ST-86", "ST-87", "ST-88", "ST-99"].map((k) => [k, true]),
    ]);
    expect(phase4.tasks.slice(1, 8).map((t) => t.title)).toEqual(["GitHub 19a", "GitHub 19b", "GitHub 19c", "GitHub 19d", "GitHub 19e", "GitHub 19f", "GitHub 19g"]);
    expect(roadmap[2]!.progress).toMatchObject({ total: 8, done: 7 });
    expect(roadmap[6]!.tasks.map((t) => t.key)).toEqual(["ST-21", "ST-27", "ST-100", "ST-101"]);

    const again = await importRoadmap(client, slug, { project: "ST", dryRun: false });
    expect(again.outcomes.filter((o) => o.action === "created" || o.action === "assigned")).toEqual([]);
    expect(importReportLines(again)).toContain("Done: 0 milestones created, 0 tasks assigned, 8 milestones and 32 tasks already in place.");
    expect((await client.milestones.list(slug, "ST")).items).toHaveLength(9);
  });
});
