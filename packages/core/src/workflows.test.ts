import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, asc, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import type { ProjectDetailDto, StatusDto, TaskKind } from "./contracts";
import { markDuplicate } from "./duplicates";
import { createOrganization } from "./organizations";
import { DEFAULT_WORKFLOWS, createProject, getProject } from "./projects";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  updateTasks,
} from "./tasks";
import { createStatus, deleteStatus, updateStatus } from "./workflows";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const names = (statuses: StatusDto[]) => statuses.map((s) => s.name);
const byName = (project: ProjectDetailDto, kind: TaskKind, name: string) => {
  const status = project.workflows[kind].find((s) => s.name === name);
  if (!status) throw new Error(`No ${kind} status ${name}`);
  return status;
};

run("task kinds and per-project workflows (ST-90)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `workflows-${Date.now()}`;
  const people: string[] = [];
  let owner: ActorContext;

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

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const user = { id: userId, name: "Owner", email: "owner@example.com" };
    const { organization, actor } = await createOrganization(db, user, {
      name: "Workflows Org",
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

  test("a new project gets the default workflow of every kind; statuses stays the task workflow", async () => {
    const project = await createProject(db, owner, {
      name: "Kinds",
      key: "KND",
    });
    for (const kind of ["task", "release", "milestone"] as const) {
      expect(names(project.workflows[kind])).toEqual(
        DEFAULT_WORKFLOWS[kind].map((s) => s.name),
      );
      expect(project.workflows[kind].map((s) => s.position)).toEqual(
        DEFAULT_WORKFLOWS[kind].map((_, i) => i),
      );
      expect(project.workflows[kind].every((s) => s.kind === kind)).toBe(true);
    }
    expect(names(project.workflows.release)).toEqual([
      "Planned",
      "On staging",
      "Release review",
      "Released",
      "Canceled",
    ]);
    expect(names(project.workflows.milestone)).toEqual([
      "Planned",
      "Active",
      "Ready to close",
      "Done",
    ]);
    expect(project.statuses).toEqual(project.workflows.task);
    expect(await getProject(db, owner, "KND")).toEqual(project);
  });

  test("a task's kind defaults to task and its status must be of its project's workflow for its kind", async () => {
    const project = await createProject(db, owner, {
      name: "Kind rules",
      key: "KRL",
    });
    const plain = await createTask(db, owner, "KRL", { title: "Plain" });
    expect(plain).toMatchObject({
      kind: "task",
      statusId: byName(project, "task", "Todo").id,
    });

    const release = await createTask(db, owner, "KRL", {
      title: "v1",
      kind: "release",
    });
    expect(release).toMatchObject({
      kind: "release",
      statusId: byName(project, "release", "Planned").id,
    });
    const milestone = await createTask(db, owner, "KRL", {
      title: "M1",
      kind: "milestone",
    });
    expect(milestone.statusId).toBe(byName(project, "milestone", "Planned").id);

    // Another kind's status is refused, on create and on update.
    await expect(
      createTask(db, owner, "KRL", {
        title: "Bad",
        kind: "release",
        statusId: byName(project, "task", "Done").id,
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("task workflow"),
    });
    await expect(
      updateTask(db, owner, plain.key, {
        statusId: byName(project, "milestone", "Done").id,
      }),
    ).rejects.toMatchObject({
      code: "validation",
    });
    const released = await updateTask(db, owner, release.key, {
      statusId: byName(project, "release", "Released").id,
    });
    expect(released.completedAt).not.toBeNull();

    // The database refuses it too.
    const wrongKind = async () => {
      await db
        .update(schema.tasks)
        .set({ statusId: byName(project, "release", "Released").id })
        .where(eq(schema.tasks.id, plain.id));
    };
    await expect(wrongKind()).rejects.toThrow();
  });

  test("list filters: kind, and status names matched in the kind's workflow or every workflow", async () => {
    await createProject(db, owner, { name: "Filters", key: "KFL" });
    const task = await createTask(db, owner, "KFL", { title: "Task" });
    const milestone = await createTask(db, owner, "KFL", {
      title: "Milestone",
      kind: "milestone",
    });
    await updateTask(db, owner, task.key, {
      statusId: (await getProject(db, owner, "KFL")).workflows.task[4]!.id,
    });
    await updateTask(db, owner, milestone.key, {
      statusId: (await getProject(db, owner, "KFL")).workflows.milestone[3]!.id,
    });

    expect((await listTasks(db, owner, "KFL")).map((t) => t.kind)).toEqual([
      "task",
      "milestone",
    ]);
    expect(
      (await listTasks(db, owner, "KFL", { kind: "milestone" })).map(
        (t) => t.key,
      ),
    ).toEqual([milestone.key]);
    // "Done" names a status in two workflows; without a kind both match.
    expect(
      (await listTasks(db, owner, "KFL", { status: ["Done"] })).map(
        (t) => t.key,
      ),
    ).toEqual([task.key, milestone.key]);
    expect(
      (
        await listTasks(db, owner, "KFL", { kind: "task", status: ["done"] })
      ).map((t) => t.key),
    ).toEqual([task.key]);
    expect(
      (await listTasks(db, owner, "KFL", { status: ["Released"] })).map(
        (t) => t.key,
      ),
    ).toEqual([]);
    await expect(
      listTasks(db, owner, "KFL", { kind: "milestone", status: ["Released"] }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("milestone workflow"),
    });
  });

  test("bulk updates match a status name in each task's own kind", async () => {
    await createProject(db, owner, { name: "Bulk", key: "KBU" });
    const task = await createTask(db, owner, "KBU", { title: "Task" });
    const release = await createTask(db, owner, "KBU", {
      title: "Release",
      kind: "release",
    });
    const project = await getProject(db, owner, "KBU");

    const result = await updateTasks(db, owner, {
      keys: [task.key, release.key],
      set: { status: "in_progress" },
    });
    expect(result.summary).toEqual({ changed: 2, unchanged: 0, failed: 0 });
    expect(result.results.map((r) => r.task?.statusId)).toEqual([
      byName(project, "task", "In Progress").id,
      byName(project, "release", "On staging").id,
    ]);
    // A name only one kind has fails for the other.
    const named = await updateTasks(db, owner, {
      keys: [task.key, release.key],
      set: { status: "Released" },
    });
    expect(named.results.map((r) => r.outcome)).toEqual(["error", "changed"]);
    expect(named.results[0]?.error?.message).toContain(
      'Unknown status "Released"',
    );
  });

  test("marking a duplicate uses the canceled status of the task's kind", async () => {
    await createProject(db, owner, { name: "Dupes", key: "KDU" });
    const project = await getProject(db, owner, "KDU");
    const a = await createTask(db, owner, "KDU", {
      title: "A",
      kind: "release",
    });
    const b = await createTask(db, owner, "KDU", {
      title: "B",
      kind: "release",
    });
    expect(
      (await markDuplicate(db, owner, b.key, { of: a.key })).statusId,
    ).toBe(byName(project, "release", "Canceled").id);
    // Milestones have no canceled status by default.
    const m1 = await createTask(db, owner, "KDU", {
      title: "M1",
      kind: "milestone",
    });
    const m2 = await createTask(db, owner, "KDU", {
      title: "M2",
      kind: "milestone",
    });
    await expect(
      markDuplicate(db, owner, m2.key, { of: m1.key }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining(
        "milestone workflow has no canceled status",
      ),
    });
  });

  test("owners add, rename, recolor and reorder statuses of a kind's workflow", async () => {
    await createProject(db, owner, { name: "Edit", key: "KED" });
    let project = await createStatus(db, owner, "KED", {
      name: "QA",
      category: "in_review",
      color: "#ff0000",
    });
    expect(names(project.workflows.task)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
      "QA",
    ]);

    project = await createStatus(db, owner, "KED", {
      kind: "release",
      name: "Hotfix",
      category: "in_progress",
      position: 1,
    });
    expect(names(project.workflows.release)).toEqual([
      "Planned",
      "Hotfix",
      "On staging",
      "Release review",
      "Released",
      "Canceled",
    ]);
    expect(project.workflows.release.map((s) => s.position)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    // The same name may be in another kind's workflow, but not twice (in any case) in one.
    await expect(
      createStatus(db, owner, "KED", {
        kind: "release",
        name: "hotfix",
        category: "todo",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      names(
        (
          await createStatus(db, owner, "KED", {
            kind: "milestone",
            name: "Hotfix",
            category: "todo",
          })
        ).workflows.milestone,
      ),
    ).toContain("Hotfix");

    const qa = byName(project, "task", "QA");
    project = await updateStatus(db, owner, "KED", qa.id, {
      name: "Testing",
      color: null,
      position: 3,
    });
    expect(names(project.workflows.task)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Testing",
      "In Review",
      "Done",
      "Canceled",
    ]);
    expect(byName(project, "task", "Testing")).toMatchObject({
      color: null,
      category: "in_review",
      position: 3,
    });
    // Past the end means last; the release workflow is untouched.
    project = await updateStatus(
      db,
      owner,
      "KED",
      byName(project, "task", "Backlog").id,
      { position: 99 },
    );
    expect(names(project.workflows.task)).toEqual([
      "Todo",
      "In Progress",
      "Testing",
      "In Review",
      "Done",
      "Canceled",
      "Backlog",
    ]);
    expect(project.workflows.task.map((s) => s.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(names(project.workflows.release)[1]).toBe("Hotfix");
    await expect(
      updateStatus(db, owner, "KED", byName(project, "task", "Todo").id, {
        name: "testing",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      updateStatus(db, owner, "KED", crypto.randomUUID(), { name: "X" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateStatus(db, owner, "KED", "nope", { name: "X" }),
    ).rejects.toMatchObject({ code: "not_found" });
    // Another project's status is not found here.
    const other = await createProject(db, owner, { name: "Other", key: "KOT" });
    await expect(
      updateStatus(db, owner, "KED", other.workflows.task[0]!.id, {
        name: "X",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const activity = await db
      .select({ action: schema.activity.action })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.entityType, "project"),
          eq(schema.activity.entityId, project.id),
        ),
      );
    expect(activity.map((a) => a.action)).toContain("project.status_updated");
  });

  test("deleting a status moves its tasks (deleted ones too) to the target first", async () => {
    let project = await createProject(db, owner, {
      name: "Delete",
      key: "KDE",
    });
    const review = byName(project, "task", "In Review");
    const done = byName(project, "task", "Done");
    const a = await createTask(db, owner, "KDE", {
      title: "A",
      statusId: review.id,
    });
    const b = await createTask(db, owner, "KDE", {
      title: "B",
      statusId: review.id,
    });
    const c = await createTask(db, owner, "KDE", {
      title: "C",
      statusId: review.id,
    });
    const already = await createTask(db, owner, "KDE", {
      title: "Already done",
      statusId: done.id,
    });
    await deleteTask(db, owner, c.key);

    // The target must be another status of the same workflow.
    await expect(
      deleteStatus(db, owner, "KDE", review.id, { moveTo: review.id }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      deleteStatus(db, owner, "KDE", review.id, {
        moveTo: byName(project, "release", "Released").id,
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      deleteStatus(db, owner, "KDE", review.id, {}),
    ).rejects.toMatchObject({ code: "validation" });

    const result = await deleteStatus(db, owner, "KDE", review.id, {
      moveTo: done.id,
    });
    expect(result.movedTasks).toBe(3);
    project = result.project;
    expect(names(project.workflows.task)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "Canceled",
    ]);
    expect(project.workflows.task.map((s) => s.position)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    const tasks = await listTasks(db, owner, "KDE", { status: ["Done"] });
    // Moved tasks go after the column's tasks, in their old order, and are now completed.
    expect(tasks.map((t) => t.title)).toEqual([
      already.title,
      a.title,
      b.title,
    ]);
    expect(tasks.every((t) => t.completedAt !== null)).toBe(true);
    const [deleted] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, c.id));
    expect(deleted?.statusId).toBe(done.id);
    const history = await db
      .select()
      .from(schema.activity)
      .where(eq(schema.activity.entityId, a.id))
      .orderBy(asc(schema.activity.id));
    expect(history.at(-1)?.changes).toEqual({ statusId: [review.id, done.id] });

    // Reopening: moving done tasks to an open status clears completedAt.
    await deleteStatus(
      db,
      owner,
      "KDE",
      byName(project, "task", "Canceled").id,
      { moveTo: done.id },
    );
    const reopened = await createStatus(db, owner, "KDE", {
      name: "Shipped",
      category: "done",
    });
    const moved = await deleteStatus(
      db,
      owner,
      "KDE",
      byName(reopened, "task", "Done").id,
      {
        moveTo: byName(reopened, "task", "Todo").id,
      },
    );
    expect(moved.movedTasks).toBe(4);
    expect((await getTask(db, owner, a.key)).completedAt).toBeNull();
  });

  test("each workflow keeps an open status and a done status", async () => {
    let project = await createProject(db, owner, { name: "Keep", key: "KKP" });
    const m = project.workflows.milestone;
    const done = byName(project, "milestone", "Done");
    const planned = byName(project, "milestone", "Planned");
    await expect(
      deleteStatus(db, owner, "KKP", done.id, { moveTo: planned.id }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("done status"),
    });
    // Down to one open status.
    for (const s of m.filter(
      (s) => s.category !== "done" && s.id !== planned.id,
    )) {
      project = (
        await deleteStatus(db, owner, "KKP", s.id, { moveTo: planned.id })
      ).project;
    }
    expect(names(project.workflows.milestone)).toEqual(["Planned", "Done"]);
    await expect(
      deleteStatus(db, owner, "KKP", planned.id, { moveTo: done.id }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("open status"),
    });
    // Canceled doesn't count as open.
    project = await createStatus(db, owner, "KKP", {
      kind: "milestone",
      name: "Dropped",
      category: "canceled",
    });
    await expect(
      deleteStatus(db, owner, "KKP", planned.id, { moveTo: done.id }),
    ).rejects.toMatchObject({ code: "validation" });
    // A second done status lets the first go.
    project = await createStatus(db, owner, "KKP", {
      kind: "milestone",
      name: "Closed",
      category: "done",
    });
    expect(
      (
        await deleteStatus(db, owner, "KKP", done.id, {
          moveTo: byName(project, "milestone", "Closed").id,
        })
      ).movedTasks,
    ).toBe(0);
  });

  test("owners, admins and their agents edit workflows; members, guests and members' agents don't", async () => {
    await createProject(db, owner, { name: "Rights", key: "KRI" });
    const project = await getProject(db, owner, "KRI");
    const todo = byName(project, "task", "Todo");
    const admin = await addPerson("admin", "wf-admin");
    expect(
      await updateStatus(db, admin, "KRI", todo.id, { name: "To do" }),
    ).toMatchObject({ key: "KRI" });
    const { actor } = await createAgent(db, owner, { name: "Owner Bot" });
    const ownerAgent: ActorContext = {
      orgId: owner.orgId,
      actorId: actor.id,
      role: "member",
      source: "mcp",
    };
    expect(
      await createStatus(db, ownerAgent, "KRI", {
        name: "Blocked",
        category: "in_progress",
      }),
    ).toMatchObject({ key: "KRI" });

    const member = await addPerson("member", "wf-member");
    const guest = await addPerson("guest", "wf-guest");
    const { actor: memberBot } = await createAgent(db, member, {
      name: "Member Bot",
    });
    const memberAgent: ActorContext = {
      orgId: owner.orgId,
      actorId: memberBot.id,
      role: "member",
      source: "mcp",
    };
    for (const who of [member, guest, memberAgent]) {
      await expect(
        createStatus(db, who, "KRI", { name: "No", category: "todo" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        updateStatus(db, who, "KRI", todo.id, { name: "No" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        deleteStatus(db, who, "KRI", todo.id, {
          moveTo: project.statuses[0]!.id,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
      });
    }
  });
});
