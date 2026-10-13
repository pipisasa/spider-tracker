import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { listTaskActivity } from "./activity-feed";
import { createAgent } from "./agents";
import { AGENT_COMMENT_LIMIT, addComment, listComments } from "./comments";
import { markDuplicate } from "./duplicates";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import { addRelation, listRelations } from "./relations";
import { createTask, getTask, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("marking duplicates (ST-114)", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `duplicates-${Date.now()}`;
  let ctx: ActorContext;
  let agent: ActorContext;
  let canceledId: string;
  let doneId: string;
  const links = async (key: string) =>
    (await listRelations(db, ctx, key)).map((r) => `${r.kind} ${r.task.key}`);
  const comments = async (key: string) =>
    (await listComments(db, ctx, key)).map((c) => c.body);
  const task = async (title: string) =>
    (await createTask(db, ctx, "DUP", { title })).key;

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: user.id,
      name: user.name,
      email: `${user.id}@example.com`,
    });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Dup Org",
      slug,
    });
    ctx = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    const bot = await createAgent(db, ctx, { name: "Dup Bot" });
    agent = {
      orgId: organization.id,
      actorId: bot.actor.id,
      role: "member",
      source: "mcp",
    };
    await createProject(db, ctx, { name: "Dups", key: "DUP" });
    const project = await getProject(db, ctx, "DUP");
    canceledId = project.statuses.find((s) => s.category === "canceled")!.id;
    doneId = project.statuses.find((s) => s.category === "done")!.id;
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("one call links, cancels and comments; a repeat changes nothing but posts a new comment", async () => {
    const [copy, original] = [await task("Subset"), await task("Original")];
    const marked = await markDuplicate(db, ctx, copy.toLowerCase(), {
      of: original,
      comment: "Same as the original",
    });
    expect(marked).toMatchObject({ key: copy, statusId: canceledId });
    expect(marked.completedAt).not.toBeNull();
    expect(await links(copy)).toEqual([`duplicates ${original}`]);
    expect(await links(original)).toEqual([`duplicated_by ${copy}`]);
    expect(await comments(copy)).toEqual([
      `Duplicate of ${original}: Original\n\nSame as the original`,
    ]);

    const activity = (await listTaskActivity(db, ctx, copy)).length;
    const again = await markDuplicate(db, ctx, copy, { of: original });
    expect(again.updatedAt).toBe(marked.updatedAt);
    expect(await comments(copy)).toHaveLength(1);
    expect(await links(copy)).toEqual([`duplicates ${original}`]);
    expect((await listTaskActivity(db, ctx, copy)).length).toBe(activity);

    // A comment given again isn't dropped: it is posted by itself (ST-131).
    await markDuplicate(db, ctx, copy, { of: original, comment: "Again" });
    expect(await comments(copy)).toEqual([
      `Duplicate of ${original}: Original\n\nSame as the original`,
      "Again",
    ]);
    expect(await links(copy)).toEqual([`duplicates ${original}`]);

    // The same comment again (a retried call) isn't posted twice; another caller's would be (ST-147).
    await markDuplicate(db, ctx, copy, { of: original, comment: "Again" });
    expect(await comments(copy)).toHaveLength(2);
  });

  test("a retried first mark with a comment posts nothing new", async () => {
    const [copy, original] = [await task("Retried"), await task("Kept")];
    const input = { of: original, comment: "Same work" };
    await markDuplicate(db, ctx, copy, input);
    await markDuplicate(db, ctx, copy, input);
    expect(await comments(copy)).toEqual([
      `Duplicate of ${original}: Kept\n\nSame work`,
    ]);
  });

  test("completes a half-done mark: an existing link, or an already canceled task", async () => {
    const [linked, closed, original] = [
      await task("Linked"),
      await task("Closed"),
      await task("Target"),
    ];
    await addRelation(db, ctx, linked, { kind: "duplicates", task: original });
    expect(
      await markDuplicate(db, ctx, linked, { of: original }),
    ).toMatchObject({ statusId: canceledId });
    expect(await comments(linked)).toEqual([
      `Duplicate of ${original}: Target`,
    ]);

    await updateTask(db, ctx, closed, { statusId: canceledId });
    const before = await getTask(db, ctx, closed);
    const marked = await markDuplicate(db, ctx, closed, { of: original });
    expect(marked.statusId).toBe(canceledId);
    expect(marked.completedAt).toBe(before.completedAt);
    expect(await links(closed)).toEqual([`duplicates ${original}`]);
    expect(await comments(closed)).toHaveLength(1);
  });

  test("a done task moves to canceled; the original may be closed or a duplicate itself", async () => {
    const [done, middle, root] = [
      await task("Done"),
      await task("Middle"),
      await task("Root"),
    ];
    await updateTask(db, ctx, done, { statusId: doneId });
    await updateTask(db, ctx, root, { statusId: doneId });
    await markDuplicate(db, ctx, middle, { of: root });
    expect(await markDuplicate(db, ctx, done, { of: middle })).toMatchObject({
      statusId: canceledId,
    });
    expect(await links(middle)).toEqual([
      `duplicates ${root}`,
      `duplicated_by ${done}`,
    ]);
  });

  test("self, cycles and a second original are refused, and nothing is written", async () => {
    const [a, b, c, d, e] = [
      await task("A"),
      await task("B"),
      await task("C"),
      await task("D"),
      await task("E"),
    ];
    await expect(markDuplicate(db, ctx, a, { of: a })).rejects.toMatchObject({
      code: "validation",
    });
    await markDuplicate(db, ctx, a, { of: b });
    await markDuplicate(db, ctx, b, { of: c });
    // D duplicates E then E duplicates D: a direct cycle; C duplicates A: one through B.
    await markDuplicate(db, ctx, d, { of: e });
    await expect(markDuplicate(db, ctx, e, { of: d })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(markDuplicate(db, ctx, c, { of: a })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      addRelation(db, ctx, c, { kind: "duplicates", task: a }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      addRelation(db, ctx, a, { kind: "duplicated_by", task: c }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(await links(c)).toEqual([`duplicated_by ${b}`]);
    expect((await getTask(db, ctx, c)).statusId).not.toBe(canceledId);
    expect(await comments(c)).toEqual([]);
    // Already a duplicate of B: another original needs the link removed first.
    await expect(markDuplicate(db, ctx, a, { of: e })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      markDuplicate(db, ctx, a, { of: "DUP-999" }),
    ).rejects.toMatchObject({ code: "not_found" });
    // A plain link can't add a second original either, from either side (ST-131).
    await expect(
      addRelation(db, ctx, a, { kind: "duplicates", task: e }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: `${a} is already a duplicate of ${b}; unlink that first`,
    });
    await expect(
      addRelation(db, ctx, e, { kind: "duplicated_by", task: a }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await links(a)).toEqual([`duplicates ${b}`]);
  });

  test("the original may be in another project; one outside an agent's projects is not found and nothing is written", async () => {
    await createProject(db, ctx, { name: "Other dups", key: "DUO" });
    await createProject(db, ctx, { name: "Hidden dups", key: "DUH" });
    const other = (await createTask(db, ctx, "DUO", { title: "Elsewhere" }))
      .key;
    const hidden = (await createTask(db, ctx, "DUH", { title: "Secret" })).key;

    const copy = await task("Cross-project copy");
    expect(await markDuplicate(db, ctx, copy, { of: other })).toMatchObject({
      statusId: canceledId,
    });
    expect(await links(other)).toEqual([`duplicated_by ${copy}`]);
    expect(await comments(copy)).toEqual([`Duplicate of ${other}: Elsewhere`]);

    // An agent scoped to DUP and DUO doesn't see DUH.
    const scoped = await createAgent(db, ctx, { name: "Scoped dup bot" });
    for (const key of ["DUP", "DUO"])
      await db.insert(schema.agentProjects).values({
        agentId: scoped.actor.id,
        projectId: (await getProject(db, ctx, key)).id,
      });
    const scopedCtx: ActorContext = { ...agent, actorId: scoped.actor.id };
    const mine = await task("Scoped copy");
    await expect(
      markDuplicate(db, scopedCtx, mine, { of: hidden }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await links(mine)).toEqual([]);
    expect(await comments(mine)).toEqual([]);
    expect((await getTask(db, ctx, mine)).statusId).not.toBe(canceledId);

    // Already a duplicate of a hidden task: the 409 doesn't name it.
    await markDuplicate(db, ctx, mine, { of: hidden });
    const conflict = await markDuplicate(db, scopedCtx, mine, {
      of: other,
    }).catch((err: unknown) => err);
    expect(conflict).toMatchObject({
      code: "conflict",
      message: `${mine} is already a duplicate of a task in a project you can't see; ask a member to unlink it`,
    });
    expect(String(conflict)).not.toContain(hidden);
    expect(await links(mine)).toEqual([`duplicates ${hidden}`]);
  });

  test("the comment counts toward an agent's per-minute limit; over it, nothing changes", async () => {
    const [copy, original] = [await task("Chatty"), await task("Quiet")];
    for (let i = 0; i < AGENT_COMMENT_LIMIT.perMinute; i++)
      await addComment(db, agent, copy, { body: `ping ${i}` });
    await expect(
      markDuplicate(db, agent, copy, { of: original }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(await links(copy)).toEqual([]);
    expect((await getTask(db, ctx, copy)).statusId).not.toBe(canceledId);
  });
});
