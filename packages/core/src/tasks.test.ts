import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { DomainError } from "./errors";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import { createTask, deleteTask, getTask, listTasks, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("projects and tasks", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `tasks-${Date.now()}`;
  let ctx: ActorContext;
  let statusIds: Record<string, string>;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Tasks Org", slug });
    ctx = { orgId: organization.id, actorId: actor.id, role: "owner", source: "api" };
    const project = await createProject(db, ctx, { name: "Spider", key: "spi" });
    statusIds = Object.fromEntries(project.statuses.map((s) => [s.category, s.id]));
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("creates a project with default statuses and rejects a duplicate key", async () => {
    const project = await getProject(db, ctx.orgId, "SPI");
    expect(project.statuses.map((s) => s.name)).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]);
    await expect(createProject(db, ctx, { name: "Again", key: "SPI" })).rejects.toMatchObject({ code: "conflict" });
  });

  test("members can't create projects", async () => {
    await expect(createProject(db, { ...ctx, role: "member" }, { name: "X", key: "XX" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("numbers tasks per project and defaults to Todo", async () => {
    const a = await createTask(db, ctx, "SPI", { title: "First" });
    const b = await createTask(db, ctx, "SPI", { title: "Second", assigneeIds: [ctx.actorId], priority: 2 });
    expect(a.key).toBe("SPI-1");
    expect(b.key).toBe("SPI-2");
    expect(a.statusId).toBe(statusIds.todo ?? "");
    expect(b.assigneeIds).toEqual([ctx.actorId]);
    expect(a.sortKey < b.sortKey).toBe(true);
  });

  test("moves a task between neighbours and into Done", async () => {
    const c = await createTask(db, ctx, "SPI", { title: "Third" });
    const [first] = await listTasks(db, ctx.orgId, "SPI");
    // Put SPI-3 before SPI-1 in Todo.
    const moved = await updateTask(db, ctx, c.key, {
      position: { statusId: statusIds.todo, beforeId: first?.id ?? null },
    });
    const order = (await listTasks(db, ctx.orgId, "SPI")).filter((t) => t.statusId === statusIds.todo).map((t) => t.key);
    expect(order[0]).toBe(moved.key);

    const done = await updateTask(db, ctx, "SPI-1", { statusId: statusIds.done });
    expect(done.completedAt).not.toBeNull();
    const reopened = await updateTask(db, ctx, "spi-1", { statusId: statusIds.todo });
    expect(reopened.completedAt).toBeNull();
  });

  test("updates assignees and records activity", async () => {
    await updateTask(db, ctx, "SPI-2", { assigneeIds: [], title: "Second (renamed)" });
    const task = await getTask(db, ctx.orgId, "SPI-2");
    expect(task.assigneeIds).toEqual([]);
    const log = await db.select().from(schema.activity).where(eq(schema.activity.entityId, task.id));
    expect(log.map((e) => e.action)).toEqual(["task.created", "task.updated"]);
    expect(log[1]?.changes).toMatchObject({ title: ["Second", "Second (renamed)"] });
  });

  test("rejects foreign statuses, unknown assignees and self-parenting", async () => {
    await expect(updateTask(db, ctx, "SPI-1", { statusId: crypto.randomUUID() })).rejects.toBeInstanceOf(DomainError);
    await expect(createTask(db, ctx, "SPI", { title: "x", assigneeIds: [crypto.randomUUID()] })).rejects.toMatchObject({
      code: "validation",
    });
    const self = await getTask(db, ctx.orgId, "SPI-1");
    await expect(updateTask(db, ctx, "SPI-1", { parentId: self.id })).rejects.toMatchObject({ code: "validation" });
  });

  test("guests can read but not write; deleted tasks disappear", async () => {
    await expect(createTask(db, { ...ctx, role: "guest" }, "SPI", { title: "nope" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await deleteTask(db, ctx, "SPI-3");
    await expect(getTask(db, ctx.orgId, "SPI-3")).rejects.toMatchObject({ code: "not_found" });
    expect((await listTasks(db, ctx.orgId, "SPI")).map((t) => t.key)).not.toContain("SPI-3");
  });
});
