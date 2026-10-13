import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { ActorContext } from "./access";
import { DomainError } from "./errors";
import { createAgent, deleteAgent } from "./agents";
import { createOrganization } from "./organizations";
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects";
import { listTaskActivity } from "./activity-feed";
import { createTag } from "./tags";
import { holdLock, settle, waitForLockWaiters } from "./test-locks.test-utils";
import { MAX_BULK_TASKS, todayUtc } from "./schemas";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  updateTasks,
} from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("projects and tasks", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const other = { id: `test-${crypto.randomUUID()}`, name: "Other" };
  const slug = `tasks-${Date.now()}`;
  let ctx: ActorContext;
  let statusIds: Record<string, string>;

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: user.id,
      name: user.name,
      email: `${user.id}@example.com`,
    });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Tasks Org",
      slug,
    });
    ctx = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "api",
    };
    const project = await createProject(db, ctx, {
      name: "Spider",
      key: "spi",
    });
    statusIds = Object.fromEntries(
      project.statuses.map((s) => [s.category, s.id]),
    );
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db
      .delete(schema.user)
      .where(inArray(schema.user.id, [user.id, other.id]));
    await db.$client.end();
  });

  test("creates a project with default statuses and rejects a duplicate key", async () => {
    const project = await getProject(db, ctx.orgId, "SPI");
    expect(project.statuses.map((s) => s.name)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
    ]);
    await expect(
      createProject(db, ctx, { name: "Again", key: "SPI" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("members can't create projects", async () => {
    await expect(
      createProject(db, { ...ctx, role: "member" }, { name: "X", key: "XX" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("updates a project's name and description; the key stays", async () => {
    await createProject(db, ctx, { name: "Docs", key: "DOC" });
    const updated = await updateProject(db, ctx, "doc", {
      name: "Documentation",
      description: "All the docs",
      key: "XYZ",
    });
    expect(updated).toMatchObject({
      key: "DOC",
      name: "Documentation",
      description: "All the docs",
      archivedAt: null,
    });
    expect(updated.statuses).toHaveLength(6);
    expect(
      (await updateProject(db, ctx, "DOC", { description: "" })).description,
    ).toBeNull();
    await expect(updateProject(db, ctx, "DOC", {})).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      updateProject(db, ctx, "NOPE", { name: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const log = await db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.entityId, updated.id))
      .orderBy(asc(schema.activity.id));
    expect(log.map((e) => e.action)).toEqual([
      "project.created",
      "project.updated",
      "project.updated",
    ]);
  });

  test("members can't change or archive projects", async () => {
    const member: ActorContext = { ...ctx, role: "member" };
    await expect(
      updateProject(db, member, "DOC", { name: "Mine" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(archiveProject(db, member, "DOC", true)).rejects.toMatchObject(
      { code: "forbidden" },
    );
  });

  test("archived projects leave the list, refuse new tasks and come back when restored", async () => {
    const archived = await archiveProject(db, ctx, "DOC", true);
    expect(archived.archivedAt).not.toBeNull();
    expect((await archiveProject(db, ctx, "DOC", true)).archivedAt).toBe(
      archived.archivedAt,
    );
    expect((await listProjects(db, ctx)).map((p) => p.key)).not.toContain(
      "DOC",
    );
    expect(
      (await listProjects(db, ctx, { includeArchived: true })).map(
        (p) => p.key,
      ),
    ).toContain("DOC");
    expect((await getProject(db, ctx, "DOC")).archivedAt).toBe(
      archived.archivedAt,
    );
    await expect(
      createTask(db, ctx, "DOC", { title: "Too late" }),
    ).rejects.toMatchObject({
      code: "validation",
      message: "Project DOC is archived",
    });

    const restored = await archiveProject(db, ctx, "DOC", false);
    expect(restored.archivedAt).toBeNull();
    expect((await listProjects(db, ctx)).map((p) => p.key)).toContain("DOC");
    expect(
      (await createTask(db, ctx, "DOC", { title: "Back again" })).key,
    ).toBe("DOC-1");
  });

  test("numbers tasks per project and defaults to Todo", async () => {
    const a = await createTask(db, ctx, "SPI", { title: "First" });
    const b = await createTask(db, ctx, "SPI", {
      title: "Second",
      assigneeIds: [ctx.actorId],
      priority: 2,
    });
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
    const order = (await listTasks(db, ctx.orgId, "SPI"))
      .filter((t) => t.statusId === statusIds.todo)
      .map((t) => t.key);
    expect(order[0]).toBe(moved.key);

    const done = await updateTask(db, ctx, "SPI-1", {
      statusId: statusIds.done,
    });
    expect(done.completedAt).not.toBeNull();
    const reopened = await updateTask(db, ctx, "spi-1", {
      statusId: statusIds.todo,
    });
    expect(reopened.completedAt).toBeNull();
  });

  test("updates assignees and records activity", async () => {
    await updateTask(db, ctx, "SPI-2", {
      assigneeIds: [],
      title: "Second (renamed)",
    });
    const task = await getTask(db, ctx.orgId, "SPI-2");
    expect(task.assigneeIds).toEqual([]);
    const log = await listTaskActivity(db, ctx.orgId, "SPI-2");
    expect(log.map((e) => e.action)).toEqual(["task.created", "task.updated"]);
    expect(log[1]).toMatchObject({
      source: "api",
      actorId: ctx.actorId,
      changes: { title: ["Second", "Second (renamed)"] },
    });
  });

  test("rejects foreign statuses, unknown assignees and self-parenting", async () => {
    await expect(
      updateTask(db, ctx, "SPI-1", { statusId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      createTask(db, ctx, "SPI", {
        title: "x",
        assigneeIds: [crypto.randomUUID()],
      }),
    ).rejects.toMatchObject({
      code: "validation",
    });
    const self = await getTask(db, ctx.orgId, "SPI-1");
    await expect(
      updateTask(db, ctx, "SPI-1", { parentId: self.id }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  test("a deactivated assignee stays assigned without blocking updates, but can't be newly assigned", async () => {
    const [gone] = await db
      .insert(schema.actors)
      .values({
        orgId: ctx.orgId,
        type: "agent",
        name: "Gone",
        handle: `gone-${Date.now()}`,
        role: "member",
      })
      .returning();
    if (!gone) throw new Error("insert failed");
    const task = await createTask(db, ctx, "SPI", {
      title: "Inherited",
      assigneeIds: [gone.id],
    });
    await db
      .update(schema.actors)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.actors.id, gone.id));

    // What start_task / assign_to_me send: the current assignees plus the caller.
    const taken = await updateTask(db, ctx, task.key, {
      assigneeIds: [gone.id, ctx.actorId],
      statusId: statusIds.in_progress,
    });
    expect(taken.assigneeIds).toEqual([gone.id, ctx.actorId]);

    const dropped = await updateTask(db, ctx, task.key, {
      assigneeIds: [ctx.actorId],
    });
    expect(dropped.assigneeIds).toEqual([ctx.actorId]);
    await expect(
      updateTask(db, ctx, task.key, { assigneeIds: [ctx.actorId, gone.id] }),
    ).rejects.toMatchObject({
      code: "validation",
    });
  });

  test("guests can read but not write; deleted tasks disappear", async () => {
    await expect(
      createTask(db, { ...ctx, role: "guest" }, "SPI", { title: "nope" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await deleteTask(db, ctx, "SPI-3");
    await expect(getTask(db, ctx.orgId, "SPI-3")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await listTasks(db, ctx.orgId, "SPI")).map((t) => t.key),
    ).not.toContain("SPI-3");
  });

  test("filters by tags (all of them, any case), priority, status, assignee and title text", async () => {
    const project = await createProject(db, ctx, {
      name: "Filters",
      key: "FLT",
    });
    const done = project.statuses.find((s) => s.category === "done")?.id;
    const bug = await createTag(db, ctx, { name: "Bug", color: "#ef4444" });
    const ui = await createTag(db, ctx, { name: "ui", color: "#22c55e" });
    const [gone] = await db
      .insert(schema.actors)
      .values({
        orgId: ctx.orgId,
        type: "agent",
        name: "Left",
        handle: `left-${Date.now()}`,
        role: "member",
      })
      .returning();
    if (!gone) throw new Error("insert failed");
    await createTask(db, ctx, "FLT", {
      title: "Both tags",
      tagIds: [bug.id, ui.id],
      priority: 1,
    });
    await createTask(db, ctx, "FLT", {
      title: "Only bug",
      tagIds: [bug.id],
      priority: 1,
      assigneeIds: [gone.id],
    });
    await createTask(db, ctx, "FLT", {
      title: "Only ui",
      tagIds: [ui.id],
      priority: 2,
      assigneeIds: [ctx.actorId],
    });
    await createTask(db, ctx, "FLT", {
      title: "Bug fixed",
      tagIds: [bug.id, ui.id],
      priority: 1,
      statusId: done,
    });
    await db
      .update(schema.actors)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.actors.id, gone.id));

    const titles = async (filters: unknown) =>
      (await listTasks(db, ctx, "FLT", filters)).map((t) => t.title).sort();
    expect(await titles({ tags: ["bug"] })).toEqual([
      "Both tags",
      "Bug fixed",
      "Only bug",
    ]);
    expect(await titles({ tags: ["BUG", "#Ui"] })).toEqual([
      "Both tags",
      "Bug fixed",
    ]);
    expect(await titles({ priority: [2] })).toEqual(["Only ui"]);
    expect(await titles({ priority: ["1", "2"] })).toHaveLength(4);
    expect(
      await titles({ tags: ["bug", "ui"], status: ["todo"], priority: [1] }),
    ).toEqual(["Both tags"]);
    expect(await titles({ status: ["Done"] })).toEqual(["Bug fixed"]);
    expect(await titles({ assignee: [`@${gone.handle}`] })).toEqual([
      "Only bug",
    ]);
    expect(await titles({ assignee: ["me", gone.id] })).toEqual([
      "Only bug",
      "Only ui",
    ]);
    expect(await titles({ assignee: ["none"] })).toEqual([
      "Both tags",
      "Bug fixed",
    ]);
    expect(await titles({ q: "ONLY" })).toEqual(["Only bug", "Only ui"]);
    expect(await titles({ q: "%" })).toEqual([]);

    await expect(
      listTasks(db, ctx, "FLT", { tags: ["nope"] }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      listTasks(db, ctx, "FLT", { status: ["Nope"] }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      listTasks(db, ctx, "FLT", { assignee: ["nobody"] }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      listTasks(db, ctx, "FLT", { priority: [7] }),
    ).rejects.toMatchObject({ code: "validation" });

    // tagMatch: all (the default) or any of the tags.
    expect(await titles({ tags: ["bug", "ui"], tagMatch: "all" })).toEqual([
      "Both tags",
      "Bug fixed",
    ]);
    expect(await titles({ tags: ["bug", "ui"], tagMatch: "any" })).toEqual([
      "Both tags",
      "Bug fixed",
      "Only bug",
      "Only ui",
    ]);
    expect(
      await titles({ tags: ["ui"], tagMatch: "any", priority: [2] }),
    ).toEqual(["Only ui"]);
    await expect(
      listTasks(db, ctx, "FLT", { tags: ["bug", "nope"], tagMatch: "any" }),
    ).rejects.toThrow('Unknown tag "nope"');
    await expect(
      listTasks(db, ctx, "FLT", { tagMatch: "some" }),
    ).rejects.toMatchObject({ code: "validation" });
    // "@" and case are ignored for me/none, as for handles.
    expect(await titles({ assignee: [" @NONE"] })).toEqual([
      "Both tags",
      "Bug fixed",
    ]);
    expect(await titles({ assignee: ["@Me"] })).toEqual(["Only ui"]);
  });

  test('"mine" is the person and their agents (deleted ones too), seen from the person or one of the agents', async () => {
    await createProject(db, ctx, { name: "Mine", key: "MIN" });
    await db
      .insert(schema.user)
      .values({ ...other, email: `${other.id}@example.com` });
    const [person] = await db
      .insert(schema.actors)
      .values({
        orgId: ctx.orgId,
        type: "human",
        userId: other.id,
        name: "Other",
        handle: `other-${Date.now()}`,
        role: "member",
      })
      .returning();
    if (!person) throw new Error("insert failed");
    const otherCtx: ActorContext = {
      ...ctx,
      actorId: person.id,
      role: "member",
    };
    const stamp = Date.now();
    const helper = await createAgent(db, ctx, {
      name: "Helper",
      handle: `helper-${stamp}`,
    });
    const retired = await createAgent(db, ctx, {
      name: "Retired",
      handle: `retired-${stamp}`,
    });
    const theirs = await createAgent(db, otherCtx, {
      name: "Theirs",
      handle: `theirs-${stamp}`,
    });
    const task = (title: string, assigneeIds: string[]) =>
      createTask(db, ctx, "MIN", { title, assigneeIds });
    await task("Mine", [ctx.actorId]);
    await task("Helper's", [helper.actor.id]);
    await task("Retired's", [retired.actor.id]);
    await task("Theirs", [theirs.actor.id]);
    await task("Other's", [person.id]);
    await task("Nobody's", []);
    await deleteAgent(db, ctx, retired.actor.id);

    const titles = async (viewer: ActorContext, filters: unknown) =>
      (await listTasks(db, viewer, "MIN", filters)).map((t) => t.title).sort();
    const mine = ["Helper's", "Mine", "Retired's"];
    expect(await titles(ctx, { assignee: ["mine"] })).toEqual(mine);
    expect(await titles(ctx, { assignee: ["@Mine", "none"] })).toEqual(
      [...mine, "Nobody's"].sort(),
    );
    // An agent's "mine" is its owner and the owner's agents, itself included.
    const helperCtx: ActorContext = {
      ...ctx,
      actorId: helper.actor.id,
      role: "member",
    };
    expect(await titles(helperCtx, { assignee: ["mine"] })).toEqual(mine);
    expect(await titles(helperCtx, { assignee: ["me"] })).toEqual(["Helper's"]);
    // Another person's agents are not mine; their "mine" is theirs.
    expect(await titles(otherCtx, { assignee: ["mine"] })).toEqual([
      "Other's",
      "Theirs",
    ]);
    const theirsCtx: ActorContext = {
      ...ctx,
      actorId: theirs.actor.id,
      role: "member",
    };
    expect(await titles(theirsCtx, { assignee: ["mine"] })).toEqual([
      "Other's",
      "Theirs",
    ]);
    await expect(
      listTasks(db, ctx.orgId, "MIN", { assignee: ["mine"] }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  test("bulk update by keys: per-task outcomes, statuses matched in each task's project, errors don't stop the rest", async () => {
    await createProject(db, ctx, { name: "Bulk A", key: "BKA" });
    await createProject(db, ctx, { name: "Bulk B", key: "BKB" });
    const a1 = await createTask(db, ctx, "BKA", { title: "A one" });
    const a2 = await createTask(db, ctx, "BKA", { title: "A two" });
    const b1 = await createTask(db, ctx, "BKB", { title: "B one" });
    await updateTask(db, ctx, a2.key, {
      statusId: (await getProject(db, ctx, "BKA")).statuses.find(
        (s) => s.category === "done",
      )?.id,
    });

    const result = await updateTasks(db, ctx, {
      keys: ["bka-1", a2.key, b1.key, "BKA-99", "nope", "BKA-1"],
      set: { status: "Done" },
    });
    expect(result.dryRun).toBe(false);
    expect(result.summary).toEqual({ changed: 2, unchanged: 1, failed: 2 });
    expect(result.results.map((r) => [r.key, r.outcome])).toEqual([
      ["BKA-1", "changed"],
      ["BKA-2", "unchanged"],
      ["BKB-1", "changed"],
      ["BKA-99", "error"],
      ["nope", "error"],
    ]);
    expect(result.results[3]?.error).toEqual({
      code: "not_found",
      message: "Task BKA-99 not found",
    });
    const bkb = await getProject(db, ctx, "BKB");
    const doneIn = (p: typeof bkb) =>
      p.statuses.find((s) => s.category === "done")?.id;
    expect((await getTask(db, ctx, b1.key)).statusId).toBe(doneIn(bkb) ?? "");
    expect((await getTask(db, ctx, a1.key)).completedAt).not.toBeNull();
    const log = await listTaskActivity(db, ctx.orgId, a1.key);
    expect(log.map((e) => e.action)).toEqual(["task.created", "task.updated"]);

    // A status missing in one task's project fails that task only.
    await db
      .update(schema.statuses)
      .set({ name: "Shipped" })
      .where(eq(schema.statuses.id, doneIn(bkb) ?? ""));
    const mixed = await updateTasks(db, ctx, {
      keys: [a1.key, b1.key],
      set: { status: "Todo", priority: 2 },
    });
    expect(mixed.results.map((r) => r.outcome)).toEqual(["changed", "changed"]);
    const renamed = await updateTasks(db, ctx, {
      keys: [a1.key, b1.key],
      set: { status: "Shipped" },
    });
    expect(renamed.results.map((r) => r.outcome)).toEqual(["error", "changed"]);
    expect(renamed.results[0]?.error?.message).toStartWith(
      'Unknown status "Shipped" in BKA',
    );
  });

  test("bulk update by filter, dry run, batch limit and bad input", async () => {
    await createProject(db, ctx, { name: "Bulk F", key: "BKF" });
    const parent = await createTask(db, ctx, "BKF", { title: "Parent" });
    for (const title of ["Kid 1", "Kid 2", "Kid 3"])
      await createTask(db, ctx, "BKF", { title, parentId: parent.id });
    await createTask(db, ctx, "BKF", { title: "Loose" });
    const backlogOf = async () =>
      (await getProject(db, ctx, "BKF")).statuses.find(
        (s) => s.category === "backlog",
      )?.id;

    const filter = { project: "bkf", parent: parent.key, status: ["todo"] };
    expect(
      (await listTasks(db, ctx, "BKF", { parent: parent.key })).map(
        (t) => t.title,
      ),
    ).toEqual(["Kid 1", "Kid 2", "Kid 3"]);

    const preview = await updateTasks(db, ctx, {
      filter,
      set: { status: "Backlog" },
      dryRun: true,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      summary: { changed: 3, unchanged: 0, failed: 0 },
    });
    expect(preview.results[0]?.task?.statusId).toBe((await backlogOf()) ?? "");
    // Nothing was written.
    expect(
      (await listTasks(db, ctx, "BKF", { status: ["backlog"] })).length,
    ).toBe(0);
    expect(
      (await listTaskActivity(db, ctx.orgId, "BKF-2")).map((e) => e.action),
    ).toEqual(["task.created"]);

    const applied = await updateTasks(db, ctx, {
      filter,
      set: { status: "Backlog" },
    });
    expect(applied.results.map((r) => [r.key, r.outcome])).toEqual([
      ["BKF-2", "changed"],
      ["BKF-3", "changed"],
      ["BKF-4", "changed"],
    ]);
    expect(
      (await listTasks(db, ctx, "BKF", { status: ["backlog"] })).map(
        (t) => t.title,
      ),
    ).toEqual(["Kid 1", "Kid 2", "Kid 3"]);
    expect(
      (await updateTasks(db, ctx, { filter, set: { status: "Backlog" } }))
        .results,
    ).toEqual([]);

    await expect(
      updateTasks(db, ctx, {
        filter: { project: "BKF", parent: "BKF-99" },
        set: { priority: 1 },
      }),
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      updateTasks(db, ctx, {
        filter: { project: "NOPE" },
        set: { priority: 1 },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const input of [
      { keys: ["BKF-1"], set: {} },
      { set: { priority: 1 } },
      { keys: ["BKF-1"], filter: { project: "BKF" }, set: { priority: 1 } },
      {
        keys: Array.from(
          { length: MAX_BULK_TASKS + 1 },
          (_, i) => `BKF-${i + 1}`,
        ),
        set: { priority: 1 },
      },
    ]) {
      await expect(updateTasks(db, ctx, input)).rejects.toMatchObject({
        code: "validation",
      });
    }
    await expect(
      updateTasks(
        db,
        { ...ctx, role: "guest" },
        { keys: ["BKF-1"], set: { priority: 1 } },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
    });

    // A filter matching more than the limit changes nothing.
    await db.insert(schema.tasks).values(
      Array.from({ length: MAX_BULK_TASKS }, (_, i) => ({
        orgId: ctx.orgId,
        projectId: parent.projectId,
        number: 1000 + i,
        title: `Filler ${i}`,
        statusId: parent.statusId,
        sortKey: `z${String(i).padStart(4, "0")}`,
        creatorId: ctx.actorId,
      })),
    );
    await expect(
      updateTasks(db, ctx, {
        filter: { project: "BKF" },
        set: { priority: 3 },
      }),
    ).rejects.toThrow(`at most ${MAX_BULK_TASKS} can be updated at once`);
    expect((await listTasks(db, ctx, "BKF", { priority: [3] })).length).toBe(0);
  });

  test("bulk update checks a scoped agent's projects per task", async () => {
    await createProject(db, ctx, { name: "In scope", key: "BKS" });
    const hidden = await createProject(db, ctx, {
      name: "Out of scope",
      key: "BKH",
    });
    const visible = await createTask(db, ctx, "BKS", { title: "Visible" });
    const secret = await createTask(db, ctx, "BKH", { title: "Secret" });
    const bot = await createAgent(db, ctx, {
      name: "Scoped bot",
      handle: `scoped-${Date.now()}`,
    });
    const scoped = await getProject(db, ctx, "BKS");
    await db
      .insert(schema.agentProjects)
      .values({ agentId: bot.actor.id, projectId: scoped.id });
    const botCtx: ActorContext = {
      ...ctx,
      actorId: bot.actor.id,
      role: "member",
    };

    const result = await updateTasks(db, botCtx, {
      keys: [visible.key, secret.key],
      set: { priority: 1 },
    });
    expect(
      result.results.map((r) => [r.key, r.outcome, r.error?.code ?? null]),
    ).toEqual([
      [visible.key, "changed", null],
      [secret.key, "error", "not_found"],
    ]);
    expect((await getTask(db, ctx, secret.key)).priority).toBe(0);
    await expect(
      updateTasks(db, botCtx, {
        filter: { project: hidden.key },
        set: { priority: 1 },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    // The filter resolves before the changes are checked: an unknown project with a bad tag is a 404.
    await expect(
      updateTasks(db, botCtx, {
        filter: { project: "NOPE" },
        set: { tagIds: ["00000000-0000-7000-8000-000000000000"] },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    // A parent outside the agent's projects fails the request like a missing one.
    await expect(
      updateTasks(db, botCtx, {
        keys: [visible.key],
        set: { parentId: secret.id },
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: "Parent task not found",
    });
    expect((await getTask(db, ctx, visible.key)).parentId).toBeNull();
  });

  test("the bulk parent check doesn't wait for the organization's parent lock", async () => {
    await createProject(db, ctx, { name: "Bulk lock", key: "BKL" });
    const parent = await createTask(db, ctx, "BKL", { title: "Parent" });
    const release = await holdLock(
      db,
      sql`select pg_advisory_xact_lock(hashtext(${"task-parent:" + ctx.orgId}))`,
    );
    try {
      // Only the request-level check runs: the task is missing, so no per-task update starts.
      const outcome = await Promise.race([
        updateTasks(db, ctx, {
          keys: ["BKL-999"],
          set: { parentId: parent.id },
        }).then((r) => r.results.map((x) => x.error?.code)),
        Bun.sleep(2000).then(() => "blocked"),
      ]);
      expect(outcome).toEqual(["not_found"]);
    } finally {
      await release();
    }
  });

  test("bulk update checks assignees, tags and the parent once, the parent's cycle per task", async () => {
    await createProject(db, ctx, { name: "Bulk once", key: "BKO" });
    const one = await createTask(db, ctx, "BKO", { title: "One" });
    const two = await createTask(db, ctx, "BKO", { title: "Two" });
    const keys = [one.key, two.key];
    const unknown = "00000000-0000-7000-8000-000000000000";

    for (const set of [
      { assigneeIds: [ctx.actorId, unknown] },
      { tagIds: [unknown] },
      { parentId: unknown },
    ]) {
      // One error for the request, not one per task; nothing is written.
      await expect(updateTasks(db, ctx, { keys, set })).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(
      (await listTaskActivity(db, ctx.orgId, one.key)).map((e) => e.action),
    ).toEqual(["task.created"]);

    // The parent is checked against each task too: it can't be its own parent.
    const result = await updateTasks(db, ctx, {
      keys,
      set: { parentId: one.id },
    });
    expect(
      result.results.map((r) => [r.key, r.outcome, r.error?.message ?? null]),
    ).toEqual([
      [one.key, "error", "A task can't be its own parent"],
      [two.key, "changed", null],
    ]);

    // A deactivated agent already assigned may stay assigned; it can't be newly assigned.
    const bot = await createAgent(db, ctx, {
      name: "Retired bot",
      handle: `retired-${Date.now()}`,
    });
    await updateTask(db, ctx, one.key, { assigneeIds: [bot.actor.id] });
    await db
      .update(schema.actors)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.actors.id, bot.actor.id));
    const kept = await updateTasks(db, ctx, {
      keys,
      set: { assigneeIds: [bot.actor.id] },
    });
    expect(
      kept.results.map((r) => [r.key, r.outcome, r.error?.code ?? null]),
    ).toEqual([
      [one.key, "unchanged", null],
      [two.key, "error", "validation"],
    ]);
  });

  test("two concurrent updates each setting one date: the second sees the first and fails validation, not the constraint", async () => {
    await createProject(db, ctx, { name: "Date race", key: "DRC" });
    const raced = await createTask(db, ctx, "DRC", { title: "Raced" });
    // Both updates wait on the task's row; each alone keeps the dates in order.
    const release = await holdLock(
      db,
      sql`select 1 from tasks where id = ${raced.id} for no key update`,
    );
    const first = settle(
      updateTask(db, ctx, raced.key, { targetDate: "2020-01-10" }),
    );
    await waitForLockWaiters(db, '"tasks"', 1);
    const second = settle(
      updateTask(db, ctx, raced.key, { startDate: "2020-02-01" }),
    );
    await waitForLockWaiters(db, '"tasks"', 2);
    await release();
    expect(await first).toBeNull();
    expect(await second).toMatchObject({
      code: "validation",
      message: "The start date must be on or before the target date",
    });
    expect(await getTask(db, ctx, raced.key)).toMatchObject({
      startDate: null,
      targetDate: "2020-01-10",
    });
  });

  test("a date-and-parent update and a parent-only update of one task don't deadlock (ST-147)", async () => {
    await createProject(db, ctx, { name: "Lock order", key: "LCK" });
    const child = await createTask(db, ctx, "LCK", { title: "Child" });
    const first = await createTask(db, ctx, "LCK", { title: "First parent" });
    const second = await createTask(db, ctx, "LCK", { title: "Second" });
    // The date-and-parent update takes the org's parent lock and queues on the row. The parent-only
    // update used to take the row's lock first; now it queues on the parent lock, behind the first.
    const release = await holdLock(
      db,
      sql`select 1 from tasks where id = ${child.id} for no key update`,
    );
    const dated = settle(
      updateTask(db, ctx, child.key, {
        parentId: first.id,
        targetDate: "2020-01-10",
      }),
    );
    await waitForLockWaiters(db, '"tasks"', 1);
    const moved = settle(
      updateTask(db, ctx, child.key, { parentId: second.id }),
    );
    await waitForLockWaiters(db, ['"tasks"', "pg_advisory_xact_lock"], 2);
    await release();
    expect(await dated).toBeNull();
    expect(await moved).toBeNull();
    expect(await getTask(db, ctx, child.key)).toMatchObject({
      parentId: second.id,
      targetDate: "2020-01-10",
    });
  });

  test("an update waiting on a task deleted meanwhile is not_found and writes nothing", async () => {
    await createProject(db, ctx, { name: "Gone", key: "GON" });
    const gone = await createTask(db, ctx, "GON", { title: "Gone" });
    // The delete holds the row until it commits; the update re-reads it then.
    const release = await holdLock(
      db,
      sql`update tasks set deleted_at = now() where id = ${gone.id}`,
    );
    const update = settle(
      updateTask(db, ctx, gone.key, { targetDate: "2020-01-10" }),
    );
    await waitForLockWaiters(db, '"tasks"', 1);
    await release();
    expect(await update).toMatchObject({
      code: "not_found",
      message: `Task ${gone.key} not found`,
    });
    const [row] = await db
      .select({ targetDate: schema.tasks.targetDate })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, gone.id));
    expect(row?.targetDate).toBeNull();
  });

  test("start and target dates: set, cleared, kept in order, recorded; overdue lists open tasks past their target", async () => {
    const project = await createProject(db, ctx, { name: "Dates", key: "DAT" });
    const done = project.statuses.find((s) => s.category === "done")?.id ?? "";
    const today = todayUtc();
    const created = await createTask(db, ctx, "DAT", {
      title: "Planned",
      startDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    expect(created).toMatchObject({
      startDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    expect(await getTask(db, ctx, created.key)).toMatchObject({
      startDate: "2020-01-01",
      targetDate: "2020-02-01",
    });

    for (const input of [
      { title: "Backwards", startDate: "2020-03-01", targetDate: "2020-02-01" },
      { title: "Not a date", targetDate: "2020-02-30" },
      { title: "With time", targetDate: "2020-02-01T00:00:00Z" },
    ]) {
      await expect(createTask(db, ctx, "DAT", input)).rejects.toMatchObject({
        code: "validation",
      });
    }
    // Checked against the stored date too.
    await expect(
      updateTask(db, ctx, created.key, { startDate: "2020-03-01" }),
    ).rejects.toMatchObject({
      code: "validation",
      message: "The start date must be on or before the target date",
    });
    const moved = await updateTask(db, ctx, created.key, {
      startDate: "2020-03-01",
      targetDate: "2020-04-01",
    });
    expect(moved).toMatchObject({
      startDate: "2020-03-01",
      targetDate: "2020-04-01",
    });
    const cleared = await updateTask(db, ctx, created.key, { startDate: null });
    expect(cleared).toMatchObject({
      startDate: null,
      targetDate: "2020-04-01",
    });
    const log = await listTaskActivity(db, ctx.orgId, created.key);
    expect(log.map((e) => e.changes)).toContainEqual({
      startDate: ["2020-03-01", null],
    });

    const future = await createTask(db, ctx, "DAT", {
      title: "Future",
      targetDate: "2999-01-01",
    });
    const dueToday = await createTask(db, ctx, "DAT", {
      title: "Due today",
      targetDate: today,
    });
    const closed = await createTask(db, ctx, "DAT", {
      title: "Late but done",
      targetDate: "2020-01-01",
      statusId: done,
    });
    await createTask(db, ctx, "DAT", { title: "Undated" });
    const overdue = await listTasks(db, ctx, "DAT", { overdue: true });
    expect(overdue.map((t) => t.key)).toEqual([created.key]);
    expect(
      (await listTasks(db, ctx, "DAT", { overdue: "true", q: "planned" })).map(
        (t) => t.key,
      ),
    ).toEqual([created.key]);
    expect((await listTasks(db, ctx, "DAT", { overdue: "false" })).length).toBe(
      5,
    );
    expect(
      [future, dueToday, closed].every(
        (t) => !overdue.some((o) => o.id === t.id),
      ),
    ).toBe(true);

    // Bulk updates set and clear dates with the same check.
    const bulk = await updateTasks(db, ctx, {
      keys: [future.key, dueToday.key],
      set: { targetDate: "2021-01-01" },
    });
    expect(bulk.results.map((r) => [r.outcome, r.task?.targetDate])).toEqual([
      ["changed", "2021-01-01"],
      ["changed", "2021-01-01"],
    ]);
    const bad = await updateTasks(db, ctx, {
      keys: [created.key],
      set: { startDate: "2030-01-01" },
    });
    expect(bad.results[0]).toMatchObject({
      outcome: "error",
      error: { code: "validation" },
    });
    expect((await listTasks(db, ctx, "DAT", { overdue: true })).length).toBe(3);
  });

  test("a missing project is not_found, filtered or not, before the filters are checked", async () => {
    for (const filters of [
      {},
      { status: ["Done"] },
      { tags: ["nope"] },
      { priority: [9] },
    ]) {
      await expect(listTasks(db, ctx, "NOPE", filters)).rejects.toMatchObject({
        code: "not_found",
      });
    }
  });
});
