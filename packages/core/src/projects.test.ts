import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { createOrganization } from "./organizations";
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("project management rights (ST-61)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `projects-${Date.now()}`;
  const people: string[] = [];
  let owner: ActorContext;

  /** Adds a person with a role and returns their context. */
  async function addPerson(
    role: ActorContext["role"],
    handle: string,
  ): Promise<ActorContext> {
    const id = `test-${crypto.randomUUID()}`;
    people.push(id);
    await db
      .insert(schema.user)
      .values({ id, name: handle, email: `${id}@example.com` });
    const [actor] = await db
      .insert(schema.actors)
      .values({
        orgId: owner.orgId,
        type: "human",
        userId: id,
        name: handle,
        handle,
        role,
      })
      .returning();
    return { orgId: owner.orgId, actorId: actor?.id ?? "", role, source: "ui" };
  }

  /** An agent owned by `by`, acting with its own key (always the `member` role). */
  async function agentOf(
    by: ActorContext,
    name: string,
  ): Promise<ActorContext> {
    const { actor } = await createAgent(db, by, { name });
    return {
      orgId: owner.orgId,
      actorId: actor.id,
      role: "member",
      source: "mcp",
    };
  }

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const user = { id: userId, name: "Owner", email: "owner@example.com" };
    const { organization, actor } = await createOrganization(db, user, {
      name: "Projects Org",
      slug,
    });
    owner = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    for (const id of [userId, ...people])
      await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("people: owners and admins manage projects; members and guests don't", async () => {
    const admin = await addPerson("admin", "admin");
    await createProject(db, owner, { name: "Owned", key: "OWN" });
    await createProject(db, admin, { name: "Admin's", key: "ADM" });
    for (const role of ["member", "guest"] as const) {
      const person = await addPerson(role, role);
      await expect(
        createProject(db, person, { name: "No", key: "NO" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        updateProject(db, person, "OWN", { name: "No" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        archiveProject(db, person, "OWN", true),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  test("an agent of an owner or admin acts with its owner's rights", async () => {
    const admin = await addPerson("admin", "admin-2");
    for (const [by, key] of [
      [owner, "AGO"],
      [admin, "AGA"],
    ] as const) {
      const agent = await agentOf(by, `Bot ${key}`);
      expect(
        await createProject(db, agent, { name: "By an agent", key }),
      ).toMatchObject({ key });
      expect(
        await updateProject(db, agent, key, { name: "Renamed" }),
      ).toMatchObject({ name: "Renamed" });
      expect(await archiveProject(db, agent, key, true)).toMatchObject({
        archivedAt: expect.any(String),
      });
      expect(await archiveProject(db, agent, key, false)).toMatchObject({
        archivedAt: null,
      });
    }
  });

  test("an agent of a member, or of a person who left, is refused", async () => {
    const member = await addPerson("member", "member-2");
    const ofMember = await agentOf(member, "Member Bot");
    await expect(
      createProject(db, ofMember, { name: "No", key: "MB" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      updateProject(db, ofMember, "OWN", { name: "No" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const leaving = await addPerson("admin", "leaving");
    const ofLeaver = await agentOf(leaving, "Orphan Bot");
    await db
      .update(schema.actors)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.actors.id, leaving.actorId));
    await expect(
      createProject(db, ofLeaver, { name: "No", key: "LV" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Only the "member" role inherits: a guest-role context stays refused even for an owner's agent.
    const ofOwner = await agentOf(owner, "Guest Bot");
    await expect(
      createProject(
        db,
        { ...ofOwner, role: "guest" },
        { name: "No", key: "GB" },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("a project-scoped agent can see and use the project it creates", async () => {
    const agent = await agentOf(owner, "Scoped Bot");
    await db
      .update(schema.agents)
      .set({ scoped: true })
      .where(eq(schema.agents.actorId, agent.actorId));

    const created = await createProject(db, agent, {
      name: "Scoped",
      key: "SCO",
    });
    // Same context: the per-request scope cache includes the new project.
    expect((await listProjects(db, agent)).map((p) => p.key)).toEqual(["SCO"]);
    // A fresh context (the next request) reads it from agent_projects.
    const next = { ...agent };
    expect(await getProject(db, next, "SCO")).toMatchObject({ id: created.id });
    expect((await listProjects(db, next)).map((p) => p.key)).toEqual(["SCO"]);
    await expect(getProject(db, next, "OWN")).rejects.toMatchObject({
      code: "not_found",
    });
    // Owner's rights don't widen the scope: projects outside it can't be changed or archived.
    await expect(
      updateProject(db, next, "OWN", { name: "No" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(archiveProject(db, next, "OWN", true)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      await updateProject(db, next, "SCO", { name: "Mine" }),
    ).toMatchObject({ name: "Mine" });

    // Unscoped agents don't get rows.
    const free = await agentOf(owner, "Free Bot");
    await createProject(db, free, { name: "Free", key: "FRE" });
    expect(
      await db
        .select()
        .from(schema.agentProjects)
        .where(eq(schema.agentProjects.agentId, free.actorId)),
    ).toEqual([]);
  });
});
