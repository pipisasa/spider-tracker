import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { listTaskActivity } from "./activity-feed";
import { createAgent } from "./agents";
import { appsAwaitingProduction } from "./board";
import { listDeployments, recordDeployment } from "./deployments";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import { createRelease, getRelease } from "./releases";
import { createApp, createRepo } from "./repos";
import { createTask, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("deployments (ST-94)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `deployments-${Date.now()}`;
  let owner: ActorContext;
  /** An agent limited to OPS. */
  let opsAgent: ActorContext;
  let ownerHandle: string;

  const statusId = async (name: string) => {
    const status = (await getProject(db, owner, "ST")).workflows.release.find((s) => s.name === name);
    if (!status) throw new Error(`No ${name}`);
    return status.id;
  };
  const moveRelease = async (key: string, name: string) => updateTask(db, owner, key, { statusId: await statusId(name) });
  const newRelease = (title: string, apps = ["web", "api", "cli"]) =>
    createRelease(db, owner, "ST", {
      title,
      apps: apps.map((app) => ({ repo: "pipisasa/spider-tracker", app, version: app === "cli" ? "0.2.0" : title })),
    });

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const org = await createOrganization(db, { id: userId, name: "Owner", email: "owner@example.com" }, { name: "Deployments", slug });
    owner = { orgId: org.organization.id, actorId: org.actor.id, role: "owner", source: "cli" };
    ownerHandle = org.actor.handle;
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Ops", key: "OPS" });
    await createRepo(db, owner, { url: "pipisasa/spider-tracker", projects: ["ST"] });
    await createRepo(db, owner, { url: "pipisasa/site", projects: ["ST"] });
    await createApp(db, owner, "pipisasa/spider-tracker", { name: "web", path: "web/app", versioning: "date", environments: ["staging", "prod"] });
    await createApp(db, owner, "pipisasa/spider-tracker", { name: "api", path: "backend/api", versioning: "date", environments: ["staging", "prod"] });
    await createApp(db, owner, "pipisasa/spider-tracker", { name: "cli", path: "backend/cli", versioning: "semver" });
    await createApp(db, owner, "pipisasa/site", { name: "web", path: ".", versioning: "date", environments: ["prod"] });
    const { actor } = await createAgent(db, owner, { name: "Ops agent" });
    await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, actor.id));
    await db.insert(schema.agentProjects).values({ agentId: actor.id, projectId: (await getProject(db, owner, "OPS")).id });
    opsAgent = { orgId: owner.orgId, actorId: actor.id, role: "member", source: "mcp" };
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("the first deploy, web to staging, moves a Planned release to On staging as the @spider bot; the deploy is the deployer's", async () => {
    const release = await newRelease("2026.10.13");
    expect(release.status.name).toBe("Planned");
    expect(release.deployments).toEqual([]);

    const recorded = await recordDeployment(db, owner, release.key, { app: "Web", environment: "staging", commitSha: "3F2C1AB9D0E4" });
    expect(recorded.movedFrom).toMatchObject({ name: "Planned", category: "todo" });
    expect(recorded.deployment).toMatchObject({
      releaseId: release.id,
      releaseKey: release.key,
      app: "web",
      repo: "pipisasa/spider-tracker",
      environment: "staging",
      production: false,
      commitSha: "3f2c1ab9d0e4",
      deployedBy: { id: owner.actorId, handle: ownerHandle },
      source: "cli",
    });
    expect(recorded.release.status.name).toBe("On staging");
    expect(recorded.release.deployments).toEqual([recorded.deployment]);
    expect((await getRelease(db, owner, release.key)).status.name).toBe("On staging");

    const activity = await listTaskActivity(db, owner, release.key);
    const deployed = activity.find((a) => a.action === "release.deployed");
    expect(deployed).toMatchObject({
      actorId: owner.actorId,
      source: "cli",
      changes: { app: "web", repo: "pipisasa/spider-tracker", environment: "staging", commitSha: "3f2c1ab9d0e4" },
    });
    const moved = activity.find((a) => a.action === "task.updated" && a.changes && "statusId" in a.changes);
    expect(moved).toMatchObject({ source: "system", changes: { statusId: [await statusId("Planned"), await statusId("On staging")] } });
    const [bot] = await db.select().from(schema.actors).where(eq(schema.actors.id, moved?.actorId ?? ""));
    expect(bot).toMatchObject({ handle: "spider", type: "integration" });

    // A second deploy leaves it where it is.
    const again = await recordDeployment(db, owner, release.key, { app: "api", environment: "staging", commitSha: "3f2c1ab" });
    expect(again.movedFrom).toBeNull();
    expect(again.release.status.name).toBe("On staging");
    expect(again.release.deployments?.map((d) => `${d.app}:${d.environment}`)).toEqual(["api:staging", "web:staging"]);
  });

  test("Released is allowed, never automatic, once every app with environments is in prod; the cli is exempt; nothing moves it backwards", async () => {
    const release = await newRelease("2026.10.14");
    await moveRelease(release.key, "Release review");
    // A staging deploy of a release under review doesn't move it back.
    const staged = await recordDeployment(db, owner, release.key, { app: "web", environment: "staging", commitSha: "aaaaaaa" });
    expect(staged.movedFrom).toBeNull();
    expect(staged.release.status.name).toBe("Release review");

    await expect(moveRelease(release.key, "Released")).rejects.toThrow(
      `Release ${release.key} can't be released: it isn't deployed api to prod, web to prod yet`,
    );
    const web = await recordDeployment(db, owner, release.key, { app: "web", environment: "prod", commitSha: "bbbbbbb" });
    expect(web.deployment.production).toBe(true);
    expect(web.release.status.name).toBe("Release review");
    expect(appsAwaitingProduction(web.release).map((c) => `${c.app}:${c.environment}`)).toEqual(["api:prod"]);
    await expect(moveRelease(release.key, "Released")).rejects.toThrow("it isn't deployed api to prod yet");

    const api = await recordDeployment(db, owner, release.key, { app: "api", environment: "prod", commitSha: "ccccccc" });
    expect(api.release.status.name).toBe("Release review");
    const released = await moveRelease(release.key, "Released");
    expect(released.shippedAt).not.toBeNull();

    // A redeploy after Released (a hotfix of the same release) is recorded and moves nothing.
    const redeploy = await recordDeployment(db, owner, release.key, { app: "api", environment: "prod", commitSha: "ddddddd" });
    expect(redeploy.movedFrom).toBeNull();
    expect(redeploy.release.status.name).toBe("Released");

    expect((await listDeployments(db, owner, release.key, { environment: "prod" })).map((d) => `${d.app}:${d.commitSha}`)).toEqual([
      "api:ddddddd",
      "api:ccccccc",
      "web:bbbbbbb",
    ]);
    expect((await listDeployments(db, owner, release.key, { app: "web" })).map((d) => d.environment)).toEqual(["prod", "staging"]);
  });

  test("a release whose apps have no environments (the cli alone) is released without deployments", async () => {
    const release = await newRelease("2026.10.15", ["cli"]);
    expect((await moveRelease(release.key, "Released")).shippedAt).not.toBeNull();
  });

  test("refused: an environment the app doesn't have, an app without environments or not in the release, a bad SHA, a canceled release, a plain task", async () => {
    const release = await newRelease("2026.10.16");
    const record = (input: Record<string, string>) => recordDeployment(db, owner, release.key, { commitSha: "abcdef1", ...input });
    await expect(record({ app: "web", environment: "stage" })).rejects.toThrow('web has no environment "stage"; its environments are staging, prod');
    await expect(record({ app: "cli", environment: "prod" })).rejects.toThrow("cli has no environments to deploy to");
    await expect(record({ app: "docs", environment: "prod" })).rejects.toThrow(
      `Release ${release.key} doesn't ship docs; it ships api (pipisasa/spider-tracker), cli (pipisasa/spider-tracker), web (pipisasa/spider-tracker)`,
    );
    await expect(record({ app: "web", environment: "prod", commitSha: "main" })).rejects.toThrow("A git commit SHA");
    expect((await getRelease(db, owner, release.key)).deployments).toEqual([]);
    expect((await getRelease(db, owner, release.key)).status.name).toBe("Planned");

    await moveRelease(release.key, "Canceled");
    await expect(record({ app: "web", environment: "staging" })).rejects.toThrow(`Release ${release.key} is Canceled; reopen it before recording deployments`);

    const task = await createTask(db, owner, "ST", { title: "Not a release" });
    await expect(recordDeployment(db, owner, task.key, { app: "web", environment: "prod", commitSha: "abcdef1" })).rejects.toThrow("is a task, not a release");
  });

  test("an app name shipped from two repos needs the repo", async () => {
    const release = await createRelease(db, owner, "ST", {
      title: "2026.10.17",
      apps: [
        { repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.17" },
        { repo: "pipisasa/site", app: "web", version: "2026.10.17" },
      ],
    });
    await expect(recordDeployment(db, owner, release.key, { app: "web", environment: "prod", commitSha: "abcdef1" })).rejects.toThrow(
      `Release ${release.key} ships web from pipisasa/site and pipisasa/spider-tracker; name the repo`,
    );
    const site = await recordDeployment(db, owner, release.key, { app: "web", repo: "https://github.com/pipisasa/site", environment: "prod", commitSha: "abcdef1" });
    expect(site.deployment).toMatchObject({ repo: "pipisasa/site", environment: "prod", production: true });
    expect(site.release.status.name).toBe("On staging");
  });

  test("a project-scoped agent can't see or deploy another project's release", async () => {
    const release = await newRelease("2026.10.18");
    await expect(recordDeployment(db, opsAgent, release.key, { app: "web", environment: "staging", commitSha: "abcdef1" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listDeployments(db, opsAgent, release.key)).rejects.toMatchObject({ code: "not_found" });
  });
});
