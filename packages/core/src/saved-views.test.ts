import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView } from "./saved-views";
import { viewFiltersSchema } from "./schemas";

describe("viewFiltersSchema", () => {
  const id = crypto.randomUUID();

  test("accepts ids, me/none, priorities and text; every key is optional", () => {
    expect(viewFiltersSchema.parse({})).toEqual({});
    const parsed = viewFiltersSchema.parse({ status: [id], assignee: ["me", "none", id], priority: [0, 4], tag: [id], q: "  bug " });
    expect(parsed.q).toBe("bug");
    expect(parsed.assignee).toEqual(["me", "none", id]);
  });

  test("rejects unknown values", () => {
    expect(viewFiltersSchema.safeParse({ status: ["nope"] }).success).toBe(false);
    expect(viewFiltersSchema.safeParse({ assignee: ["someone"] }).success).toBe(false);
    expect(viewFiltersSchema.safeParse({ priority: [5] }).success).toBe(false);
    expect(viewFiltersSchema.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("saved views", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `views-${Date.now()}`;
  let owner: ActorContext;
  let member: ActorContext;
  let agent: ActorContext;
  let otherProjectId: string;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const org = await createOrganization(db, user, { name: "Views Org", slug });
    owner = { orgId: org.organization.id, actorId: org.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "SPI" });
    const other = await createProject(db, owner, { name: "Other", key: "OTH" });
    otherProjectId = other.id;
    const memberUser = { id: `test-${crypto.randomUUID()}`, name: "Member", email: "m@example.com" };
    await db.insert(schema.user).values({ id: memberUser.id, name: memberUser.name, email: `${memberUser.id}@example.com` });
    const [memberActor] = await db
      .insert(schema.actors)
      .values({ orgId: owner.orgId, type: "human", userId: memberUser.id, name: "Member", handle: "member", role: "member" })
      .returning();
    if (!memberActor) throw new Error("member actor");
    member = { ...owner, actorId: memberActor.id, role: "member" };
    const created = await createAgent(db, owner, { name: "Scoped Bot" });
    agent = { ...owner, actorId: created.actor.id, role: "member", source: "api" };
    const [spi] = await db.select().from(schema.projects).where(and(eq(schema.projects.orgId, owner.orgId), eq(schema.projects.key, "SPI")));
    if (!spi) throw new Error("project");
    await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, agent.actorId));
    await db.insert(schema.agentProjects).values({ agentId: agent.actorId, projectId: spi.id });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("create, list, update and delete a personal view", async () => {
    const status = crypto.randomUUID();
    const view = await createSavedView(db, owner, "spi", { name: "Mine", filters: { status: [status], assignee: ["me"] } });
    expect(view).toMatchObject({ name: "Mine", projectKey: "SPI", shared: false, view: "board", ownerActorId: owner.actorId });
    expect(view.filters).toEqual({ status: [status], assignee: ["me"] });
    const renamed = await updateSavedView(db, owner, "SPI", view.id, { name: "Mine 2", view: "list", shared: true });
    expect(renamed).toMatchObject({ name: "Mine 2", view: "list", shared: true });
    await expect(updateSavedView(db, owner, "SPI", view.id, {})).rejects.toMatchObject({ code: "validation" });
    await expect(createSavedView(db, owner, "SPI", { name: " " })).rejects.toMatchObject({ code: "validation" });
    await expect(createSavedView(db, owner, "SPI", { name: "x", filters: { priority: [9] } })).rejects.toMatchObject({ code: "validation" });
    await deleteSavedView(db, owner, "SPI", view.id);
    expect(await listSavedViews(db, owner, "SPI")).toEqual([]);
    await expect(deleteSavedView(db, owner, "SPI", view.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateSavedView(db, owner, "SPI", "not-a-uuid", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("guests can't create; personal views are private, shared ones visible; only owners and admins edit others'", async () => {
    await expect(createSavedView(db, { ...member, role: "guest" }, "SPI", { name: "No" })).rejects.toMatchObject({ code: "forbidden" });

    const personal = await createSavedView(db, member, "SPI", { name: "Private" });
    const shared = await createSavedView(db, member, "SPI", { name: "Team", shared: true });
    expect((await listSavedViews(db, owner, "SPI")).map((v) => v.name)).toEqual(["Team"]);
    expect((await listSavedViews(db, member, "SPI")).map((v) => v.name)).toEqual(["Private", "Team"]);
    expect((await listSavedViews(db, { ...owner, role: "guest" }, "SPI")).map((v) => v.name)).toEqual(["Team"]);

    // A personal view of someone else doesn't exist for the others.
    await expect(updateSavedView(db, owner, "SPI", personal.id, { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    // Organization owners edit and delete shared views; other members can't.
    const other = await createSavedView(db, owner, "SPI", { name: "Owner shared", shared: true });
    await expect(updateSavedView(db, member, "SPI", other.id, { name: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteSavedView(db, member, "SPI", other.id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await updateSavedView(db, owner, "SPI", shared.id, { name: "Team 2" })).name).toBe("Team 2");
    await deleteSavedView(db, owner, "SPI", shared.id);
    // A view can't be reached through another project.
    await expect(updateSavedView(db, owner, "OTH", other.id, { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(listSavedViews(db, owner, "NOPE")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a scoped agent uses views of its projects only", async () => {
    await db.insert(schema.savedViews).values({
      orgId: owner.orgId,
      projectId: otherProjectId,
      ownerActorId: owner.actorId,
      name: "Hidden",
      shared: true,
    });
    const names = (await listSavedViews(db, agent, "SPI")).map((v) => v.name);
    expect(names).toContain("Owner shared");
    expect(names).not.toContain("Private");
    await expect(listSavedViews(db, agent, "OTH")).rejects.toMatchObject({ code: "not_found" });
    await expect(createSavedView(db, agent, "OTH", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect((await createSavedView(db, agent, "SPI", { name: "Bot view" })).ownerActorId).toBe(agent.actorId);
  });
});
