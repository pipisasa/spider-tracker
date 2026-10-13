import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, desc, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import { addToRelease, createRelease } from "./releases";
import {
  compareMilestones,
  createMilestone,
  getMilestone,
  listMilestones,
} from "./milestones";
import {
  createTask,
  deleteTask,
  getTask,
  updateTask,
  updateTasks,
} from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("milestones (ST-96)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `milestones-${Date.now()}`;
  let owner: ActorContext;

  const statusOf = async (
    projectKey: string,
    kind: "task" | "release" | "milestone",
    name: string,
  ) => {
    const project = await getProject(db, owner, projectKey);
    const status = project.workflows[kind].find((s) => s.name === name);
    if (!status) throw new Error(`No ${name}`);
    return status.id;
  };
  const move = async (
    key: string,
    name: string,
    kind: "task" | "release" | "milestone" = "task",
  ) =>
    updateTask(db, owner, key, {
      statusId: await statusOf(key.split("-")[0] ?? "", kind, name),
    });
  const statusName = async (key: string) =>
    (await getMilestone(db, owner, key)).status.name;

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const org = await createOrganization(
      db,
      { id: userId, name: "Owner", email: "owner@example.com" },
      { name: "Milestones", slug },
    );
    owner = {
      orgId: org.organization.id,
      actorId: org.actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Ops", key: "OPS" });
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("a milestone groups tasks and their sub-tasks; progress counts Done tasks and shipped code; the bot moves it to Ready to close", async () => {
    const milestone = await createMilestone(db, owner, "st", {
      title: "Phase 4: Git and GitHub",
      description:
        "**Goal:** code and tasks stay in sync.\n\n**Done when:** merging a PR moves its task to Done.",
      targetDate: "2026-11-30",
    });
    expect(milestone).toMatchObject({
      kind: "milestone",
      status: { name: "Planned", category: "todo" },
      progress: {
        total: 0,
        done: 0,
        canceled: 0,
        withCode: 0,
        shipped: 0,
        complete: false,
      },
      tasks: [],
      releases: [],
    });

    const app = await createTask(db, owner, "ST", {
      title: "GitHub App",
      milestoneId: milestone.id,
    });
    expect(app.milestoneId).toBe(milestone.id);
    expect(app.milestone).toMatchObject({
      key: milestone.key,
      title: "Phase 4: Git and GitHub",
      inherited: false,
      status: { name: "Planned" },
    });
    const sub = await createTask(db, owner, "ST", {
      title: "Webhooks",
      parentId: app.id,
    });
    expect(sub.milestoneId).toBeNull();
    expect(sub.milestone).toMatchObject({
      key: milestone.key,
      inherited: true,
    });
    const docs = await createTask(db, owner, "ST", { title: "Docs" });
    await updateTask(db, owner, docs.key, { milestoneId: milestone.id });
    await move(milestone.key, "Active", "milestone");

    let view = await getMilestone(db, owner, milestone.key);
    expect(view.tasks.map((t) => [t.key, t.inherited, t.parentKey])).toEqual([
      [app.key, false, null],
      [sub.key, true, app.key],
      [docs.key, false, null],
    ]);
    expect(view.progress).toMatchObject({ total: 3, done: 0 });

    await move(app.key, "Done");
    await move(sub.key, "Done");
    await updateTask(db, owner, docs.key, {
      statusId: await statusOf("ST", "task", "Done"),
      noCode: true,
    });
    view = await getMilestone(db, owner, milestone.key);
    // Done, but the code of two tasks hasn't shipped: it stays Active.
    expect(view.progress).toEqual({
      total: 3,
      done: 3,
      canceled: 0,
      withCode: 2,
      shipped: 0,
      complete: false,
    });
    expect(view.status.name).toBe("Active");

    const release = await createRelease(db, owner, "ST", {
      title: "2026.10.14",
      tasks: [app.key],
    });
    await addToRelease(db, owner, release.key, { tasks: [sub.key] });
    view = await getMilestone(db, owner, milestone.key);
    expect(view.releases).toEqual([
      {
        id: release.id,
        key: release.key,
        title: "2026.10.14",
        status: expect.objectContaining({ name: "Planned" }),
        shippedAt: null,
        tasks: [app.key, sub.key],
      },
    ]);
    expect(view.tasks.find((t) => t.key === app.key)?.shipping).toMatchObject({
      state: "in_release",
    });

    await move(release.key, "Released", "release");
    view = await getMilestone(db, owner, milestone.key);
    expect(view.progress).toMatchObject({
      withCode: 2,
      shipped: 2,
      complete: true,
    });
    expect(view.status).toMatchObject({
      name: "Ready to close",
      category: "in_review",
    });
    expect(view.releases[0]?.shippedAt).not.toBeNull();

    // The Spider Tracker bot moved it, with source "system".
    const [entry] = await db
      .select({
        actorId: schema.activity.actorId,
        source: schema.activity.source,
        changes: schema.activity.changes,
      })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.entityId, milestone.id),
          eq(schema.activity.action, "task.updated"),
        ),
      )
      .orderBy(desc(schema.activity.id))
      .limit(1);
    const [bot] = await db
      .select()
      .from(schema.actors)
      .where(eq(schema.actors.id, entry?.actorId ?? ""));
    expect(bot).toMatchObject({
      type: "integration",
      handle: "spider",
      name: "Spider Tracker",
    });
    expect(entry?.source).toBe("system");

    // A person closes it; the tracker never moves it back.
    await move(milestone.key, "Done", "milestone");
    await createTask(db, owner, "ST", {
      title: "Late addition",
      milestoneId: milestone.id,
    });
    expect(await statusName(milestone.key)).toBe("Done");
  });

  test("canceled tasks don't count; an empty milestone stays; finishing the last task, deleting it or moving it out completes one", async () => {
    const empty = await createMilestone(db, owner, "ST", { title: "Empty" });
    const m = await createMilestone(db, owner, "ST", {
      title: "Small",
      statusId: await statusOf("ST", "milestone", "Active"),
    });
    const a = await createTask(db, owner, "ST", {
      title: "A",
      milestoneId: m.id,
    });
    const b = await createTask(db, owner, "ST", {
      title: "B",
      milestoneId: m.id,
    });
    const c = await createTask(db, owner, "ST", {
      title: "C",
      milestoneId: m.id,
    });
    await updateTask(db, owner, a.key, {
      statusId: await statusOf("ST", "task", "Done"),
      noCode: true,
    });
    await move(b.key, "Canceled");
    expect((await getMilestone(db, owner, m.key)).progress).toEqual({
      total: 2,
      done: 1,
      canceled: 1,
      withCode: 0,
      shipped: 0,
      complete: false,
    });

    // Moving the open task out completes it.
    await updateTask(db, owner, c.key, { milestoneId: null });
    expect(await statusName(m.key)).toBe("Ready to close");
    expect(await statusName(empty.key)).toBe("Planned");

    // Deleting the last open task completes another one.
    const m2 = await createMilestone(db, owner, "ST", { title: "Delete" });
    const d = await createTask(db, owner, "ST", {
      title: "D",
      milestoneId: m2.id,
    });
    await updateTask(db, owner, d.key, {
      statusId: await statusOf("ST", "task", "Done"),
      noCode: true,
    });
    expect(await statusName(m2.key)).toBe("Ready to close");
    await move(m2.key, "Active", "milestone");
    const e = await createTask(db, owner, "ST", {
      title: "E",
      milestoneId: m2.id,
    });
    await deleteTask(db, owner, e.key);
    expect(await statusName(m2.key)).toBe("Ready to close");
  });

  test("membership follows the parent; a sub-task's own milestone wins; bulk updates set it; deleting a milestone frees its tasks", async () => {
    const m1 = await createMilestone(db, owner, "ST", { title: "One" });
    const m2 = await createMilestone(db, owner, "ST", { title: "Two" });
    const parent = await createTask(db, owner, "ST", {
      title: "Parent",
      milestoneId: m1.id,
    });
    const child = await createTask(db, owner, "ST", {
      title: "Child",
      parentId: parent.id,
    });
    const grandchild = await createTask(db, owner, "ST", {
      title: "Grandchild",
      parentId: child.id,
    });
    const own = await createTask(db, owner, "ST", {
      title: "Own",
      parentId: parent.id,
      milestoneId: m2.id,
    });
    expect((await getTask(db, owner, grandchild.key)).milestone).toMatchObject({
      key: m1.key,
      inherited: true,
    });
    expect((await getTask(db, owner, own.key)).milestone).toMatchObject({
      key: m2.key,
      inherited: false,
    });

    await updateTask(db, owner, parent.key, { milestoneId: m2.id });
    expect((await getMilestone(db, owner, m1.key)).tasks).toEqual([]);
    expect(
      (await getMilestone(db, owner, m2.key)).tasks.map((t) => t.title),
    ).toEqual(["Parent", "Child", "Grandchild", "Own"]);

    const loose = await createTask(db, owner, "ST", { title: "Loose" });
    await updateTask(db, owner, child.key, { parentId: loose.id });
    expect((await getTask(db, owner, grandchild.key)).milestone).toBeNull();

    const bulk = await updateTasks(db, owner, {
      keys: [loose.key, grandchild.key],
      set: { milestoneId: m1.id },
    });
    expect(bulk.summary).toEqual({ changed: 2, unchanged: 0, failed: 0 });
    expect(
      (await getMilestone(db, owner, m1.key)).tasks.map((t) => [
        t.title,
        t.inherited,
      ]),
    ).toEqual([
      ["Child", true],
      ["Grandchild", false],
      ["Loose", false],
    ]);

    await deleteTask(db, owner, m1.key);
    expect((await getTask(db, owner, loose.key)).milestoneId).toBeNull();
    expect((await getTask(db, owner, grandchild.key)).milestone).toBeNull();
  });

  test("only tasks join, and only a milestone of their own project", async () => {
    const m = await createMilestone(db, owner, "ST", { title: "Rules" });
    const opsTask = await createTask(db, owner, "OPS", { title: "Elsewhere" });
    await expect(
      updateTask(db, owner, opsTask.key, { milestoneId: m.id }),
    ).rejects.toThrow("its own project");
    const release = await createRelease(db, owner, "ST", {
      title: "2026.10.15",
    });
    await expect(
      updateTask(db, owner, release.key, { milestoneId: m.id }),
    ).rejects.toThrow("Only tasks go into a milestone");
    const plain = await createTask(db, owner, "ST", { title: "Plain" });
    await expect(
      updateTask(db, owner, plain.key, { milestoneId: release.id }),
    ).rejects.toThrow("is a release, not a milestone");
    await expect(
      updateTask(db, owner, plain.key, { milestoneId: plain.id }),
    ).rejects.toThrow("is a task, not a milestone");
    await expect(getMilestone(db, owner, plain.key)).rejects.toThrow(
      "not a milestone",
    );
  });

  test("the roadmap lists milestones by date; a scoped agent sees only its projects' tasks", async () => {
    await createProject(db, owner, { name: "Road", key: "RD" });
    const late = await createMilestone(db, owner, "RD", {
      title: "Late",
      targetDate: "2027-03-01",
    });
    const undated = await createMilestone(db, owner, "RD", {
      title: "Undated",
    });
    const early = await createMilestone(db, owner, "RD", {
      title: "Early",
      startDate: "2026-10-01",
      targetDate: "2026-12-01",
    });
    const roadmap = await listMilestones(db, owner, "rd");
    expect(roadmap.map((m) => m.title)).toEqual(["Early", "Late", "Undated"]);
    expect(
      (await listMilestones(db, owner, "RD", { status: ["Planned"] })).map(
        (m) => m.key,
      ),
    ).toEqual([early.key, late.key, undated.key]);
    expect(
      await listMilestones(db, owner, "RD", { status: ["Active"] }),
    ).toEqual([]);
    expect(
      compareMilestones(
        { targetDate: null, startDate: null, number: 1 },
        { targetDate: null, startDate: null, number: 2 },
      ),
    ).toBeLessThan(0);

    // A sub-task in OPS under an RD task doesn't inherit the RD milestone: membership stays inside
    // the milestone's project.
    const parent = await createTask(db, owner, "RD", {
      title: "Road task",
      milestoneId: early.id,
    });
    const opsChild = await createTask(db, owner, "OPS", {
      title: "Ops child",
      parentId: parent.id,
    });
    const rdChild = await createTask(db, owner, "RD", {
      title: "Road child",
      parentId: opsChild.id,
    });
    expect((await getTask(db, owner, opsChild.key)).milestone).toBeNull();
    // Nor does the walk pass through another project's task to reach it.
    expect((await getTask(db, owner, rdChild.key)).milestone).toBeNull();
    expect(
      (await getMilestone(db, owner, early.key)).tasks.map((t) => t.key),
    ).toEqual([parent.key]);
    const { actor } = await createAgent(db, owner, { name: "Ops only" });
    await db
      .update(schema.agents)
      .set({ scoped: true })
      .where(eq(schema.agents.actorId, actor.id));
    await db.insert(schema.agentProjects).values({
      agentId: actor.id,
      projectId: (await getProject(db, owner, "OPS")).id,
    });
    const agent: ActorContext = {
      orgId: owner.orgId,
      actorId: actor.id,
      role: "member",
      source: "mcp",
    };
    expect((await getTask(db, agent, opsChild.key)).milestone).toBeNull();
    await expect(listMilestones(db, agent, "RD")).rejects.toThrow("not found");
  });

  test("an OPS-scoped agent finishing an OPS sub-task of an RD task doesn't move the RD milestone", async () => {
    const m = await createMilestone(db, owner, "RD", {
      title: "Cross",
      statusId: await statusOf("RD", "milestone", "Active"),
    });
    const parent = await createTask(db, owner, "RD", {
      title: "Cross parent",
      milestoneId: m.id,
    });
    const opsChild = await createTask(db, owner, "OPS", {
      title: "Cross child",
      parentId: parent.id,
    });
    // The RD task alone completes the milestone; the open OPS child doesn't hold it back.
    await updateTask(db, owner, parent.key, {
      statusId: await statusOf("RD", "task", "Done"),
      noCode: true,
    });
    expect(await statusName(m.key)).toBe("Ready to close");
    // A person reopens it, then the OPS agent finishes its task: the RD milestone stays put.
    await move(m.key, "Active", "milestone");
    const { actor } = await createAgent(db, owner, { name: "Ops finisher" });
    await db
      .update(schema.agents)
      .set({ scoped: true })
      .where(eq(schema.agents.actorId, actor.id));
    await db.insert(schema.agentProjects).values({
      agentId: actor.id,
      projectId: (await getProject(db, owner, "OPS")).id,
    });
    const agent: ActorContext = {
      orgId: owner.orgId,
      actorId: actor.id,
      role: "member",
      source: "mcp",
    };
    await updateTask(db, agent, opsChild.key, {
      statusId: await statusOf("OPS", "task", "Done"),
      noCode: true,
    });
    expect(await statusName(m.key)).toBe("Active");
    await deleteTask(db, agent, opsChild.key);
    expect(await statusName(m.key)).toBe("Active");
  });

  test("a task created already closed settles its milestone", async () => {
    const m = await createMilestone(db, owner, "ST", { title: "Born closed" });
    const a = await createTask(db, owner, "ST", {
      title: "Finished",
      milestoneId: m.id,
    });
    await updateTask(db, owner, a.key, {
      statusId: await statusOf("ST", "task", "Done"),
      noCode: true,
    });
    expect(await statusName(m.key)).toBe("Ready to close");
    await move(m.key, "Active", "milestone");
    // Creating a task in it settles it again, as any change to one of its tasks does.
    await createTask(db, owner, "ST", {
      title: "Dropped",
      milestoneId: m.id,
      statusId: await statusOf("ST", "task", "Canceled"),
    });
    expect(await statusName(m.key)).toBe("Ready to close");
    // A task created Done whose code hasn't shipped keeps it open.
    await move(m.key, "Active", "milestone");
    await createTask(db, owner, "ST", {
      title: "Done, unshipped",
      milestoneId: m.id,
      statusId: await statusOf("ST", "task", "Done"),
    });
    expect(await statusName(m.key)).toBe("Active");
  });
});
