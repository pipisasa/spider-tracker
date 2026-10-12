import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { addComment } from "./comments";
import { createOrganization } from "./organizations";
import { activeAgentsForTasks, activeAgentsInProject, PRESENCE_WINDOW_MS } from "./presence";
import { createProject } from "./projects";
import { createTask, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("agent presence", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `presence-${Date.now()}`;
  let owner: ActorContext;
  let alpha: ActorContext;
  let taskId = "";
  const since = () => new Date(Date.now() - PRESENCE_WINDOW_MS);

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Presence Org", slug });
    owner = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    const a = await createAgent(db, owner, { name: "Alpha" });
    alpha = { orgId: organization.id, actorId: a.actor.id, role: "member", source: "mcp" };
    await createProject(db, owner, { name: "Spider", key: "SPI" });
    await createProject(db, owner, { name: "Other", key: "OTH" });
    taskId = (await createTask(db, owner, "SPI", { title: "Work" })).id;
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("human activity does not count", async () => {
    await addComment(db, owner, "SPI-1", { body: "hello" });
    expect(await activeAgentsInProject(db, owner, "SPI", since())).toEqual([]);
    expect(await activeAgentsForTasks(db, owner, [taskId], since())).toEqual([]);
  });

  test("an agent's recent activity marks it active", async () => {
    await updateTask(db, alpha, "SPI-1", { title: "Work, in progress" });
    const byProject = await activeAgentsInProject(db, owner, "SPI", since());
    expect(byProject).toMatchObject([{ taskKey: "SPI-1", actorId: alpha.actorId }]);
    expect(await activeAgentsForTasks(db, owner, [taskId], since())).toEqual(byProject);
    expect(await activeAgentsForTasks(db, owner, [], since())).toEqual([]);
  });

  test("old activity does not count", async () => {
    expect(await activeAgentsInProject(db, owner, "SPI", new Date(Date.now() + 60_000))).toEqual([]);
    await db
      .update(schema.activity)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.activity.actorId, alpha.actorId));
    expect(await activeAgentsInProject(db, owner, "SPI", since())).toEqual([]);
  });

  test("tasks outside an agent's project scope are hidden", async () => {
    await updateTask(db, alpha, "SPI-1", { title: "Work again" });
    expect(await activeAgentsInProject(db, { ...alpha }, "SPI", since())).toHaveLength(1);
    const [other] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.key, "OTH"));
    await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, alpha.actorId));
    await db.insert(schema.agentProjects).values({ agentId: alpha.actorId, projectId: other?.id ?? "" });
    // Scope is looked up once per context object: use a fresh one.
    const viewer = { ...alpha };
    expect(await activeAgentsForTasks(db, viewer, [taskId], since())).toEqual([]);
    expect(activeAgentsInProject(db, viewer, "SPI", since())).rejects.toMatchObject({ code: "not_found" });
  });
});
