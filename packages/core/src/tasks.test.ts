import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { DomainError } from "./errors";
import { createOrganization } from "./organizations";
import { archiveProject, createProject, getProject, listProjects, updateProject } from "./projects";
import { listTaskActivity } from "./activity-feed";
import { createTag } from "./tags";
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

  test("updates a project's name and description; the key stays", async () => {
    await createProject(db, ctx, { name: "Docs", key: "DOC" });
    const updated = await updateProject(db, ctx, "doc", { name: "Documentation", description: "All the docs", key: "XYZ" });
    expect(updated).toMatchObject({ key: "DOC", name: "Documentation", description: "All the docs", archivedAt: null });
    expect(updated.statuses).toHaveLength(6);
    expect((await updateProject(db, ctx, "DOC", { description: "" })).description).toBeNull();
    await expect(updateProject(db, ctx, "DOC", {})).rejects.toMatchObject({ code: "validation" });
    await expect(updateProject(db, ctx, "NOPE", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    const log = await db.select().from(schema.activity).where(eq(schema.activity.entityId, updated.id));
    expect(log.map((e) => e.action)).toEqual(["project.created", "project.updated", "project.updated"]);
  });

  test("members can't change or archive projects", async () => {
    const member: ActorContext = { ...ctx, role: "member" };
    await expect(updateProject(db, member, "DOC", { name: "Mine" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(archiveProject(db, member, "DOC", true)).rejects.toMatchObject({ code: "forbidden" });
  });

  test("archived projects leave the list, refuse new tasks and come back when restored", async () => {
    const archived = await archiveProject(db, ctx, "DOC", true);
    expect(archived.archivedAt).not.toBeNull();
    expect((await archiveProject(db, ctx, "DOC", true)).archivedAt).toBe(archived.archivedAt);
    expect((await listProjects(db, ctx)).map((p) => p.key)).not.toContain("DOC");
    expect((await listProjects(db, ctx, { includeArchived: true })).map((p) => p.key)).toContain("DOC");
    expect((await getProject(db, ctx, "DOC")).archivedAt).toBe(archived.archivedAt);
    await expect(createTask(db, ctx, "DOC", { title: "Too late" })).rejects.toMatchObject({
      code: "validation",
      message: "Project DOC is archived",
    });

    const restored = await archiveProject(db, ctx, "DOC", false);
    expect(restored.archivedAt).toBeNull();
    expect((await listProjects(db, ctx)).map((p) => p.key)).toContain("DOC");
    expect((await createTask(db, ctx, "DOC", { title: "Back again" })).key).toBe("DOC-1");
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
    const log = await listTaskActivity(db, ctx.orgId, "SPI-2");
    expect(log.map((e) => e.action)).toEqual(["task.created", "task.updated"]);
    expect(log[1]).toMatchObject({ source: "api", actorId: ctx.actorId, changes: { title: ["Second", "Second (renamed)"] } });
  });

  test("rejects foreign statuses, unknown assignees and self-parenting", async () => {
    await expect(updateTask(db, ctx, "SPI-1", { statusId: crypto.randomUUID() })).rejects.toBeInstanceOf(DomainError);
    await expect(createTask(db, ctx, "SPI", { title: "x", assigneeIds: [crypto.randomUUID()] })).rejects.toMatchObject({
      code: "validation",
    });
    const self = await getTask(db, ctx.orgId, "SPI-1");
    await expect(updateTask(db, ctx, "SPI-1", { parentId: self.id })).rejects.toMatchObject({ code: "validation" });
  });

  test("a deactivated assignee stays assigned without blocking updates, but can't be newly assigned", async () => {
    const [gone] = await db
      .insert(schema.actors)
      .values({ orgId: ctx.orgId, type: "agent", name: "Gone", handle: `gone-${Date.now()}`, role: "member" })
      .returning();
    if (!gone) throw new Error("insert failed");
    const task = await createTask(db, ctx, "SPI", { title: "Inherited", assigneeIds: [gone.id] });
    await db.update(schema.actors).set({ deactivatedAt: new Date() }).where(eq(schema.actors.id, gone.id));

    // What start_task / assign_to_me send: the current assignees plus the caller.
    const taken = await updateTask(db, ctx, task.key, { assigneeIds: [gone.id, ctx.actorId], statusId: statusIds.in_progress });
    expect(taken.assigneeIds).toEqual([gone.id, ctx.actorId]);

    const dropped = await updateTask(db, ctx, task.key, { assigneeIds: [ctx.actorId] });
    expect(dropped.assigneeIds).toEqual([ctx.actorId]);
    await expect(updateTask(db, ctx, task.key, { assigneeIds: [ctx.actorId, gone.id] })).rejects.toMatchObject({
      code: "validation",
    });
  });

  test("guests can read but not write; deleted tasks disappear", async () => {
    await expect(createTask(db, { ...ctx, role: "guest" }, "SPI", { title: "nope" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await deleteTask(db, ctx, "SPI-3");
    await expect(getTask(db, ctx.orgId, "SPI-3")).rejects.toMatchObject({ code: "not_found" });
    expect((await listTasks(db, ctx.orgId, "SPI")).map((t) => t.key)).not.toContain("SPI-3");
  });

  test("filters by tags (all of them, any case), priority, status, assignee and title text", async () => {
    const project = await createProject(db, ctx, { name: "Filters", key: "FLT" });
    const done = project.statuses.find((s) => s.category === "done")?.id;
    const bug = await createTag(db, ctx, { name: "Bug", color: "#ef4444" });
    const ui = await createTag(db, ctx, { name: "ui", color: "#22c55e" });
    const [gone] = await db
      .insert(schema.actors)
      .values({ orgId: ctx.orgId, type: "agent", name: "Left", handle: `left-${Date.now()}`, role: "member" })
      .returning();
    if (!gone) throw new Error("insert failed");
    await createTask(db, ctx, "FLT", { title: "Both tags", tagIds: [bug.id, ui.id], priority: 1 });
    await createTask(db, ctx, "FLT", { title: "Only bug", tagIds: [bug.id], priority: 1, assigneeIds: [gone.id] });
    await createTask(db, ctx, "FLT", { title: "Only ui", tagIds: [ui.id], priority: 2, assigneeIds: [ctx.actorId] });
    await createTask(db, ctx, "FLT", { title: "Bug fixed", tagIds: [bug.id, ui.id], priority: 1, statusId: done });
    await db.update(schema.actors).set({ deactivatedAt: new Date() }).where(eq(schema.actors.id, gone.id));

    const titles = async (filters: unknown) => (await listTasks(db, ctx, "FLT", filters)).map((t) => t.title).sort();
    expect(await titles({ tags: ["bug"] })).toEqual(["Both tags", "Bug fixed", "Only bug"]);
    expect(await titles({ tags: ["BUG", "#Ui"] })).toEqual(["Both tags", "Bug fixed"]);
    expect(await titles({ priority: [2] })).toEqual(["Only ui"]);
    expect(await titles({ priority: ["1", "2"] })).toHaveLength(4);
    expect(await titles({ tags: ["bug", "ui"], status: ["todo"], priority: [1] })).toEqual(["Both tags"]);
    expect(await titles({ status: ["Done"] })).toEqual(["Bug fixed"]);
    expect(await titles({ assignee: [`@${gone.handle}`] })).toEqual(["Only bug"]);
    expect(await titles({ assignee: ["me", gone.id] })).toEqual(["Only bug", "Only ui"]);
    expect(await titles({ assignee: ["none"] })).toEqual(["Both tags", "Bug fixed"]);
    expect(await titles({ q: "ONLY" })).toEqual(["Only bug", "Only ui"]);
    expect(await titles({ q: "%" })).toEqual([]);

    await expect(listTasks(db, ctx, "FLT", { tags: ["nope"] })).rejects.toMatchObject({ code: "validation" });
    await expect(listTasks(db, ctx, "FLT", { status: ["Nope"] })).rejects.toMatchObject({ code: "validation" });
    await expect(listTasks(db, ctx, "FLT", { assignee: ["nobody"] })).rejects.toMatchObject({ code: "validation" });
    await expect(listTasks(db, ctx, "FLT", { priority: [7] })).rejects.toMatchObject({ code: "validation" });

    // tagMatch: all (the default) or any of the tags.
    expect(await titles({ tags: ["bug", "ui"], tagMatch: "all" })).toEqual(["Both tags", "Bug fixed"]);
    expect(await titles({ tags: ["bug", "ui"], tagMatch: "any" })).toEqual(["Both tags", "Bug fixed", "Only bug", "Only ui"]);
    expect(await titles({ tags: ["ui"], tagMatch: "any", priority: [2] })).toEqual(["Only ui"]);
    await expect(listTasks(db, ctx, "FLT", { tags: ["bug", "nope"], tagMatch: "any" })).rejects.toThrow('Unknown tag "nope"');
    await expect(listTasks(db, ctx, "FLT", { tagMatch: "some" })).rejects.toMatchObject({ code: "validation" });
    // "@" and case are ignored for me/none, as for handles.
    expect(await titles({ assignee: [" @NONE"] })).toEqual(["Both tags", "Bug fixed"]);
    expect(await titles({ assignee: ["@Me"] })).toEqual(["Only ui"]);
  });

  test("a missing project is not_found, filtered or not, before the filters are checked", async () => {
    for (const filters of [{}, { status: ["Done"] }, { tags: ["nope"] }, { priority: [9] }]) {
      await expect(listTasks(db, ctx, "NOPE", filters)).rejects.toMatchObject({ code: "not_found" });
    }
  });
});
