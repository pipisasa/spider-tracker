import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import {
  attachRepo,
  createApp,
  createRepo,
  deleteApp,
  deleteRepo,
  detachRepo,
  getRepo,
  listRepos,
  updateApp,
  updateRepo,
} from "./repos";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("repos and apps (ST-92)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slugs = [`repos-${Date.now()}`, `repos-other-${Date.now()}`];
  const people: string[] = [];
  let owner: ActorContext;
  let other: ActorContext;
  let member: ActorContext;
  let guest: ActorContext;
  /** An owner's agent: manages repos with its owner's rights. */
  let ownersAgent: ActorContext;
  /** An owner's agent limited to OPS. */
  let opsAgent: ActorContext;
  /** A member's agent: reads, but can't manage. */
  let membersAgent: ActorContext;

  async function addPerson(role: ActorContext["role"], handle: string): Promise<ActorContext> {
    const id = `test-${crypto.randomUUID()}`;
    people.push(id);
    await db.insert(schema.user).values({ id, name: handle, email: `${id}@example.com` });
    const [actor] = await db
      .insert(schema.actors)
      .values({ orgId: owner.orgId, type: "human", userId: id, name: handle, handle, role })
      .returning();
    return { orgId: owner.orgId, actorId: actor?.id ?? "", role, source: "ui" };
  }

  async function agentOf(by: ActorContext, name: string, projectKeys?: string[]): Promise<ActorContext> {
    const { actor } = await createAgent(db, by, { name });
    if (projectKeys) {
      await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, actor.id));
      for (const key of projectKeys) {
        const project = await getProject(db, owner.orgId, key);
        await db.insert(schema.agentProjects).values({ agentId: actor.id, projectId: project.id });
      }
    }
    return { orgId: owner.orgId, actorId: actor.id, role: "member", source: "mcp" };
  }

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const user = { id: userId, name: "Owner", email: "owner@example.com" };
    const a = await createOrganization(db, user, { name: "Repos Org", slug: slugs[0] });
    const b = await createOrganization(db, user, { name: "Other Org", slug: slugs[1] });
    owner = { orgId: a.organization.id, actorId: a.actor.id, role: "owner", source: "ui" };
    other = { orgId: b.organization.id, actorId: b.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Ops", key: "OPS" });
    member = await addPerson("member", "member");
    guest = await addPerson("guest", "guest");
    ownersAgent = await agentOf(owner, "Owner's agent");
    opsAgent = await agentOf(owner, "Ops agent", ["OPS"]);
    membersAgent = await agentOf(member, "Member's agent");
  });

  afterAll(async () => {
    for (const slug of slugs) await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const id of [userId, ...people]) await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("spider-tracker: a repo attached to ST with apps web, api (staging, prod) and cli (semver, no environments)", async () => {
    const repo = await createRepo(db, ownersAgent, { url: "git@github.com:pipisasa/spider-tracker.git", projects: ["st"] });
    expect(repo).toMatchObject({
      owner: "pipisasa",
      name: "spider-tracker",
      fullName: "pipisasa/spider-tracker",
      defaultBranch: "main",
      githubInstallationId: null,
      projects: ["ST"],
      apps: [],
    });

    const web = await createApp(db, ownersAgent, "pipisasa/spider-tracker", {
      name: "web",
      path: "web/app",
      sharedPaths: ["packages/core", "packages/sdk"],
      versioning: "date",
      environments: ["staging", "prod"],
    });
    expect(web).toMatchObject({ repo: "pipisasa/spider-tracker", repoId: repo.id, name: "web", versioning: "date" });
    await createApp(db, owner, repo.id, {
      name: "api",
      path: "./backend/api/",
      sharedPaths: ["packages/core", "packages/db"],
      versioning: "date",
      environments: ["staging", "prod"],
    });
    const cli = await createApp(db, owner, "https://github.com/PIPISASA/Spider-Tracker", { name: "cli", path: "backend/cli" });
    expect(cli).toMatchObject({ versioning: "semver", environments: [], sharedPaths: [] });

    const full = await getRepo(db, member, "pipisasa/spider-tracker");
    expect(full.apps.map((a) => [a.name, a.path, a.versioning, a.environments])).toEqual([
      ["api", "backend/api", "date", ["staging", "prod"]],
      ["cli", "backend/cli", "semver", []],
      ["web", "web/app", "date", ["staging", "prod"]],
    ]);
    expect((await listRepos(db, guest, { project: "st" })).map((r) => r.fullName)).toEqual(["pipisasa/spider-tracker"]);
    expect(await listRepos(db, owner, { project: "OPS" })).toEqual([]);
  });

  test("the same remote can't be added twice, whatever its casing; other orgs are separate", async () => {
    await expect(createRepo(db, owner, { url: "https://github.com/PipiSasa/Spider-Tracker.git" })).rejects.toMatchObject({
      code: "conflict",
      message: "Repo PipiSasa/Spider-Tracker already exists",
    });
    await expect(createRepo(db, owner, { url: "https://gitlab.com/a/b" })).rejects.toMatchObject({ code: "validation" });
    await expect(createRepo(db, owner, { url: "a/b", projects: ["NOPE"] })).rejects.toMatchObject({ code: "not_found" });
    expect(await listRepos(db, owner)).toHaveLength(1);

    const theirs = await createRepo(db, other, { url: "pipisasa/spider-tracker" });
    expect(theirs.projects).toEqual([]);
    await expect(getRepo(db, owner, theirs.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getRepo(db, other, "not-a-repo")).rejects.toMatchObject({ code: "not_found" });
  });

  test("owners, admins and their agents manage; members, guests and members' agents only read", async () => {
    const admin = await addPerson("admin", "admin");
    for (const ctx of [member, guest, membersAgent]) {
      await expect(createRepo(db, ctx, { url: "x/y" })).rejects.toMatchObject({ code: "forbidden", message: "Your role can't add repos" });
      await expect(createApp(db, ctx, "pipisasa/spider-tracker", { name: "x", path: "x" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(attachRepo(db, ctx, "OPS", { repo: "pipisasa/spider-tracker" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(deleteRepo(db, ctx, "pipisasa/spider-tracker")).rejects.toMatchObject({ code: "forbidden" });
      expect((await listRepos(db, ctx)).map((r) => r.fullName)).toEqual(["pipisasa/spider-tracker"]);
    }
    const docs = await createRepo(db, admin, { url: "https://github.com/pipisasa/docs", defaultBranch: "trunk" });
    expect(docs).toMatchObject({ defaultBranch: "trunk", projects: [] });
    await deleteRepo(db, admin, "pipisasa/docs");
    await expect(getRepo(db, owner, docs.id)).rejects.toMatchObject({ code: "not_found" });
  });

  test("attach and detach are idempotent and recorded", async () => {
    const attached = await attachRepo(db, owner, "ops", { repo: "pipisasa/spider-tracker" });
    expect(attached.projects).toEqual(["OPS", "ST"]);
    expect((await attachRepo(db, owner, "OPS", { repo: "pipisasa/spider-tracker" })).projects).toEqual(["OPS", "ST"]);
    expect((await detachRepo(db, owner, "OPS", "pipisasa/spider-tracker")).projects).toEqual(["ST"]);
    expect((await detachRepo(db, owner, "OPS", "pipisasa/spider-tracker")).projects).toEqual(["ST"]);
    await expect(attachRepo(db, owner, "NOPE", { repo: "pipisasa/spider-tracker" })).rejects.toMatchObject({ code: "not_found" });
    await expect(attachRepo(db, owner, "OPS", { repo: "nobody/nothing" })).rejects.toMatchObject({ code: "not_found" });

    const repo = await getRepo(db, owner, "pipisasa/spider-tracker");
    const log = await db
      .select({ action: schema.activity.action })
      .from(schema.activity)
      .where(and(eq(schema.activity.entityType, "repo"), eq(schema.activity.entityId, repo.id)));
    expect(log.map((l) => l.action)).toEqual(["repo.created", "repo.attached", "repo.detached"]);
  });

  test("a project-scoped agent sees only its projects' repos and can't remove shared ones", async () => {
    expect(await listRepos(db, opsAgent)).toEqual([]);
    await expect(getRepo(db, opsAgent, "pipisasa/spider-tracker")).rejects.toMatchObject({ code: "not_found" });
    await expect(attachRepo(db, opsAgent, "OPS", { repo: "pipisasa/spider-tracker" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createRepo(db, opsAgent, { url: "pipisasa/runbooks" })).rejects.toMatchObject({ code: "validation" });
    await expect(createRepo(db, opsAgent, { url: "pipisasa/runbooks", projects: ["ST"] })).rejects.toMatchObject({ code: "not_found" });

    const runbooks = await createRepo(db, opsAgent, { url: "pipisasa/runbooks", projects: ["OPS"] });
    expect(runbooks.projects).toEqual(["OPS"]);
    // Shared with ST, the agent still sees only OPS in its projects, and may not remove it.
    await attachRepo(db, owner, "ST", { repo: "pipisasa/runbooks" });
    expect((await getRepo(db, opsAgent, "pipisasa/runbooks")).projects).toEqual(["OPS"]);
    expect((await getRepo(db, owner, "pipisasa/runbooks")).projects).toEqual(["OPS", "ST"]);
    await expect(deleteRepo(db, opsAgent, "pipisasa/runbooks")).rejects.toMatchObject({ code: "forbidden" });
    await detachRepo(db, owner, "ST", "pipisasa/runbooks");
    await deleteRepo(db, opsAgent, "pipisasa/runbooks");
    expect((await listRepos(db, owner)).map((r) => r.fullName)).toEqual(["pipisasa/spider-tracker"]);
  });

  test("update a repo's remote and default branch; renames can't collide", async () => {
    await createRepo(db, owner, { url: "pipisasa/old-name" });
    const renamed = await updateRepo(db, owner, "pipisasa/old-name", { url: "https://github.com/pipisasa/new-name.git", defaultBranch: "develop" });
    expect(renamed).toMatchObject({ fullName: "pipisasa/new-name", defaultBranch: "develop" });
    await expect(updateRepo(db, owner, "pipisasa/new-name", { url: "pipisasa/spider-tracker" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(updateRepo(db, owner, "pipisasa/new-name", {})).rejects.toMatchObject({ code: "validation" });
    await expect(updateRepo(db, owner, "pipisasa/new-name", { defaultBranch: "a..b" })).rejects.toMatchObject({ code: "validation" });
    await deleteRepo(db, owner, renamed.id);
  });

  test("update and remove apps; names are unique within a repo", async () => {
    await expect(createApp(db, owner, "pipisasa/spider-tracker", { name: "WEB", path: "x" })).rejects.toMatchObject({
      code: "conflict",
      message: "App web already exists in pipisasa/spider-tracker",
    });
    const updated = await updateApp(db, owner, "pipisasa/spider-tracker", "Web", { environments: ["prod"], sharedPaths: [] });
    expect(updated).toMatchObject({ name: "web", environments: ["prod"], sharedPaths: [] });
    await expect(updateApp(db, owner, "pipisasa/spider-tracker", "web", { name: "api" })).rejects.toMatchObject({ code: "conflict" });
    await expect(updateApp(db, owner, "pipisasa/spider-tracker", "nope", { path: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(updateApp(db, member, "pipisasa/spider-tracker", "web", { path: "x" })).rejects.toMatchObject({ code: "forbidden" });

    const site = await createApp(db, owner, "pipisasa/spider-tracker", { name: "site", path: "web/site" });
    const renamed = await updateApp(db, owner, "pipisasa/spider-tracker", "site", { name: "landing" });
    expect(renamed).toMatchObject({ id: site.id, name: "landing" });
    await deleteApp(db, owner, "pipisasa/spider-tracker", "landing");
    await expect(deleteApp(db, owner, "pipisasa/spider-tracker", "landing")).rejects.toMatchObject({ code: "not_found" });
    const log = await db
      .select({ action: schema.activity.action })
      .from(schema.activity)
      .where(and(eq(schema.activity.entityType, "app"), eq(schema.activity.entityId, site.id)));
    expect(log.map((l) => l.action)).toEqual(["app.created", "app.updated", "app.deleted"]);
  });

  test("deleting a project or a repo removes the links and apps", async () => {
    await createProject(db, owner, { name: "Temp", key: "TMP" });
    await attachRepo(db, owner, "TMP", { repo: "pipisasa/spider-tracker" });
    await db.delete(schema.projects).where(and(eq(schema.projects.orgId, owner.orgId), eq(schema.projects.key, "TMP")));
    expect((await getRepo(db, owner, "pipisasa/spider-tracker")).projects).toEqual(["ST"]);

    const extra = await createRepo(db, owner, { url: "pipisasa/extra", projects: ["ST"] });
    await createApp(db, owner, extra.id, { name: "x", path: "." });
    await deleteRepo(db, owner, "pipisasa/extra");
    expect(await db.select().from(schema.apps).where(eq(schema.apps.repoId, extra.id))).toEqual([]);
    expect(await db.select().from(schema.projectRepos).where(eq(schema.projectRepos.repoId, extra.id))).toEqual([]);
  });
});
