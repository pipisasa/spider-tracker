import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq, sql } from "drizzle-orm";
import { listTaskActivity } from "./activity-feed";
import type { ActorContext } from "./access";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { addRelation, listRelations, removeRelation } from "./relations";
import { createTask, deleteTask } from "./tasks";
import { holdLock, settle, waitForLockWaiters } from "./test-locks.test-utils";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("task relations", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `relations-${Date.now()}`;
  let ctx: ActorContext;
  // A request waits either on the locked task (inserting the link) or on the pair lock.
  const pairWaits = ['"task_relations"', "pg_advisory_xact_lock"];
  const kinds = async (key: string) => (await listRelations(db, ctx.orgId, key)).map((r) => `${r.kind} ${r.task.key}`);

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Rel Org", slug });
    ctx = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    for (const title of ["API", "Web", "Docs", "Dup"]) await createTask(db, ctx, "SPI", { title });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("each side sees the link from its own point of view", async () => {
    await addRelation(db, ctx, "SPI-1", { kind: "blocks", task: "SPI-2" });
    await addRelation(db, ctx, "SPI-2", { kind: "relates", task: "spi-3" });
    await addRelation(db, ctx, "SPI-1", { kind: "duplicated_by", task: "SPI-4" });
    expect(await kinds("SPI-1")).toEqual(["blocks SPI-2", "duplicated_by SPI-4"]);
    expect(await kinds("SPI-2")).toEqual(["blocked_by SPI-1", "relates SPI-3"]);
    expect(await kinds("SPI-3")).toEqual(["relates SPI-2"]);
    expect(await kinds("SPI-4")).toEqual(["duplicates SPI-1"]);
  });

  test("duplicates, mutual blocking and self links are refused", async () => {
    await expect(addRelation(db, ctx, "SPI-2", { kind: "blocked_by", task: "SPI-1" })).rejects.toMatchObject({ code: "conflict" });
    await expect(addRelation(db, ctx, "SPI-3", { kind: "relates", task: "SPI-2" })).rejects.toMatchObject({ code: "conflict" });
    await expect(addRelation(db, ctx, "SPI-2", { kind: "blocks", task: "SPI-1" })).rejects.toMatchObject({ code: "validation" });
    await expect(addRelation(db, ctx, "SPI-1", { kind: "relates", task: "SPI-1" })).rejects.toMatchObject({ code: "validation" });
  });

  test("removing from either side; deleted tasks drop out", async () => {
    await removeRelation(db, ctx, "SPI-3", { kind: "relates", task: "SPI-2" });
    expect(await kinds("SPI-2")).toEqual(["blocked_by SPI-1"]);
    await removeRelation(db, ctx, "SPI-2", { kind: "blocked_by", task: "SPI-1" });
    expect(await kinds("SPI-1")).toEqual(["duplicated_by SPI-4"]);
    await expect(removeRelation(db, ctx, "SPI-1", { kind: "blocks", task: "SPI-2" })).rejects.toMatchObject({ code: "not_found" });
    await deleteTask(db, ctx, "SPI-4");
    expect(await kinds("SPI-1")).toEqual([]);
  });

  test("the same link added from both sides at once is stored once", async () => {
    const [a, b] = [await createTask(db, ctx, "SPI", { title: "Left" }), await createTask(db, ctx, "SPI", { title: "Right" })];
    // Both pass the "already linked?" check, then queue on the foreign-key check of a locked task.
    const release = await holdLock(db, sql`select 1 from tasks where id = ${a.id} for update`);
    const results = [
      settle(addRelation(db, ctx, a.key, { kind: "relates", task: b.key })),
      settle(addRelation(db, ctx, b.key, { kind: "relates", task: a.key })),
    ];
    await waitForLockWaiters(db, pairWaits, 2);
    await release();
    const errors = await Promise.all(results);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.find((e) => e !== null)).toMatchObject({ code: "conflict" });
    expect(await kinds(a.key)).toEqual([`relates ${b.key}`]);
    await removeRelation(db, ctx, a.key, { kind: "relates", task: b.key });
  });

  test("two tasks blocking each other at once: one is refused", async () => {
    const [a, b] = [await createTask(db, ctx, "SPI", { title: "North" }), await createTask(db, ctx, "SPI", { title: "South" })];
    // Without the pair lock both would pass the mutual-block check, then queue on the locked task.
    const release = await holdLock(db, sql`select 1 from tasks where id = ${a.id} for update`);
    const results = [
      settle(addRelation(db, ctx, a.key, { kind: "blocks", task: b.key })),
      settle(addRelation(db, ctx, b.key, { kind: "blocks", task: a.key })),
    ];
    await waitForLockWaiters(db, pairWaits, 2);
    await release();
    const errors = await Promise.all(results);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.find((e) => e !== null)).toMatchObject({ code: "validation" });
    expect(await kinds(a.key)).toHaveLength(1);
  });

  test("two removes at once: the second is not found and records nothing", async () => {
    const [a, b] = [await createTask(db, ctx, "SPI", { title: "Once" }), await createTask(db, ctx, "SPI", { title: "Twice" })];
    await addRelation(db, ctx, a.key, { kind: "blocks", task: b.key });
    // Both find the link, then queue on its locked row.
    const release = await holdLock(db, sql`select 1 from task_relations where from_task_id = ${a.id} and to_task_id = ${b.id} for update`);
    const results = [
      settle(removeRelation(db, ctx, a.key, { kind: "blocks", task: b.key })),
      settle(removeRelation(db, ctx, b.key, { kind: "blocked_by", task: a.key })),
    ];
    await waitForLockWaiters(db, '"task_relations"', 2);
    await release();
    const errors = await Promise.all(results);
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.find((e) => e !== null)).toMatchObject({ code: "not_found" });
    for (const key of [a.key, b.key]) {
      const removed = (await listTaskActivity(db, ctx.orgId, key)).filter((e) => e.action === "relation.removed");
      expect(removed).toHaveLength(1);
    }
  });

  test("adding and removing a link is recorded on both tasks", async () => {
    const [a, b] = [await createTask(db, ctx, "SPI", { title: "Blocker" }), await createTask(db, ctx, "SPI", { title: "Blocked" })];
    await addRelation(db, ctx, a.key, { kind: "blocks", task: b.key });
    await removeRelation(db, ctx, b.key, { kind: "blocked_by", task: a.key });
    const log = async (key: string) =>
      (await listTaskActivity(db, ctx.orgId, key))
        .filter((e) => e.action.startsWith("relation."))
        .map((e) => ({ action: e.action, changes: e.changes }));
    expect(await log(a.key)).toEqual([
      { action: "relation.added", changes: { kind: "blocks", task: b.key } },
      { action: "relation.removed", changes: { kind: "blocks", task: b.key } },
    ]);
    expect(await log(b.key)).toEqual([
      { action: "relation.added", changes: { kind: "blocked_by", task: a.key } },
      { action: "relation.removed", changes: { kind: "blocked_by", task: a.key } },
    ]);
  });
});
