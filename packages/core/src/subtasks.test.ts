import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createOrganization } from "./organizations";
import { createAgentInvite, acceptAgentInvite } from "./agent-invites";
import { createProject, getProject } from "./projects";
import { listTaskActivity } from "./activity-feed";
import {
  createTask,
  deleteTask,
  getTask,
  listSubtasks,
  listTasks,
  updateTask,
} from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("sub-tasks", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `subtasks-${Date.now()}`;
  let ctx: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: user.id,
      name: user.name,
      email: `${user.id}@example.com`,
    });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Sub Org",
      slug,
    });
    ctx = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    await createProject(db, ctx, { name: "Web", key: "WEB" });
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("children carry parentKey and are listed under the parent, across projects", async () => {
    const epic = await createTask(db, ctx, "SPI", { title: "Epic" });
    const child = await createTask(db, ctx, "SPI", {
      title: "Child",
      parentId: epic.id,
    });
    const other = await createTask(db, ctx, "WEB", {
      title: "Web part",
      parentId: epic.id,
    });
    expect(child.parentKey).toBe("SPI-1");
    expect((await getTask(db, ctx.orgId, other.key)).parentKey).toBe("SPI-1");
    expect(
      (await listSubtasks(db, ctx.orgId, "SPI-1")).map((t) => t.key),
    ).toEqual(["SPI-2", "WEB-1"]);
    expect((await getTask(db, ctx.orgId, "SPI-1")).parentKey).toBeNull();
  });

  test("no cycles: not itself, not a descendant", async () => {
    const grandchild = await createTask(db, ctx, "SPI", {
      title: "Grandchild",
      parentId: (await getTask(db, ctx.orgId, "SPI-2")).id,
    });
    await expect(
      updateTask(db, ctx, "SPI-1", { parentId: grandchild.id }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("sub-task of this one"),
    });
    const self = await getTask(db, ctx.orgId, "SPI-2");
    await expect(
      updateTask(db, ctx, "SPI-2", { parentId: self.id }),
    ).rejects.toMatchObject({ code: "validation" });

    // Moving a sub-tree elsewhere is fine; clearing the parent too.
    const moved = await updateTask(db, ctx, "SPI-2", {
      parentId: (await getTask(db, ctx.orgId, "WEB-1")).id,
    });
    expect(moved.parentKey).toBe("WEB-1");
    expect(
      (await updateTask(db, ctx, "SPI-2", { parentId: null })).parentKey,
    ).toBeNull();
  });
  test("deleting a parent detaches its sub-tasks, which keep accepting sub-tasks", async () => {
    const parent = await createTask(db, ctx, "SPI", { title: "Doomed parent" });
    const child = await createTask(db, ctx, "WEB", {
      title: "Orphan-to-be",
      parentId: parent.id,
    });
    await deleteTask(db, ctx, parent.key);

    const detached = await getTask(db, ctx.orgId, child.key);
    expect(detached.parentId).toBeNull();
    expect(detached.parentKey).toBeNull();
    const log = await listTaskActivity(db, ctx.orgId, child.key);
    expect(log.at(-1)).toMatchObject({
      action: "task.updated",
      changes: { parentId: [parent.id, null] },
    });

    const grandchild = await createTask(db, ctx, "SPI", {
      title: "Still works",
      parentId: child.id,
    });
    expect(grandchild.parentKey).toBe(child.key);
  });

  const doneStatus = async (projectKey: string) => {
    const project = await getProject(db, ctx.orgId, projectKey);
    return project.statuses.find((st) => st.category === "done")!;
  };

  test("sub-tasks carry their own status; a done child in another project counts as done", async () => {
    const parent = await createTask(db, ctx, "SPI", { title: "Cross parent" });
    const local = await createTask(db, ctx, "SPI", {
      title: "Local",
      parentId: parent.id,
    });
    const remote = await createTask(db, ctx, "WEB", {
      title: "Remote",
      parentId: parent.id,
    });
    expect((await getTask(db, ctx.orgId, parent.key)).subtasks).toEqual({
      done: 0,
      total: 2,
    });

    const webDone = await doneStatus("WEB");
    await updateTask(db, ctx, remote.key, { statusId: webDone.id });

    const subs = await listSubtasks(db, ctx.orgId, parent.key);
    expect(subs.map((t) => [t.key, t.status.category])).toEqual([
      [local.key, "todo"],
      [remote.key, "done"],
    ]);
    expect(subs[1]!.status).toMatchObject({
      id: webDone.id,
      name: webDone.name,
    });
    expect(subs[0]!.subtasks).toBeNull();

    // Progress on get, list and update responses.
    expect((await getTask(db, ctx.orgId, parent.key)).subtasks).toEqual({
      done: 1,
      total: 2,
    });
    const listed = await listTasks(db, ctx.orgId, "SPI");
    expect(listed.find((t) => t.id === parent.id)?.subtasks).toEqual({
      done: 1,
      total: 2,
    });
    expect(listed.find((t) => t.id === local.id)?.subtasks).toBeNull();
    expect(
      (await updateTask(db, ctx, parent.key, { title: "Cross parent!" }))
        .subtasks,
    ).toEqual({ done: 1, total: 2 });

    // Deleted children drop out of the count.
    await deleteTask(db, ctx, local.key);
    expect((await getTask(db, ctx.orgId, parent.key)).subtasks).toEqual({
      done: 1,
      total: 1,
    });
  });

  test("a scoped agent's progress and sub-task list leave out children in other projects", async () => {
    const parent = await createTask(db, ctx, "SPI", { title: "Scoped parent" });
    await createTask(db, ctx, "SPI", { title: "Visible", parentId: parent.id });
    const hidden = await createTask(db, ctx, "WEB", {
      title: "Hidden",
      parentId: parent.id,
    });
    await updateTask(db, ctx, hidden.key, {
      statusId: (await doneStatus("WEB")).id,
    });

    const { invite } = await createAgentInvite(db, ctx, {
      projectKeys: ["SPI"],
    });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const agent = (): ActorContext => ({
      orgId: ctx.orgId,
      actorId: actor.id,
      role: "member",
      source: "api",
    });

    expect((await getTask(db, agent(), parent.key)).subtasks).toEqual({
      done: 0,
      total: 1,
    });
    expect(
      (await listTasks(db, agent(), "SPI")).find((t) => t.id === parent.id)
        ?.subtasks,
    ).toEqual({ done: 0, total: 1 });
    expect(
      (await listSubtasks(db, agent(), parent.key)).map((t) => t.title),
    ).toEqual(["Visible"]);
    // The owner still counts both.
    expect((await getTask(db, ctx.orgId, parent.key)).subtasks).toEqual({
      done: 1,
      total: 2,
    });
  });

  test("concurrent re-parenting can't create a cycle", async () => {
    const a = await createTask(db, ctx, "SPI", { title: "Race A" });
    const b = await createTask(db, ctx, "SPI", { title: "Race B" });
    const results = await Promise.allSettled([
      updateTask(db, ctx, a.key, { parentId: b.id }),
      updateTask(db, ctx, b.key, { parentId: a.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [fa, fb] = await Promise.all([
      getTask(db, ctx.orgId, a.key),
      getTask(db, ctx.orgId, b.key),
    ]);
    expect([fa.parentId, fb.parentId].filter(Boolean)).toHaveLength(1);
  });
});
