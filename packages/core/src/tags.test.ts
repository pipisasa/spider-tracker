import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { listTaskActivity } from "./activity-feed";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createTag, deleteTag, listTags } from "./tags";
import { createTask, getTask, listTasks, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("tags", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slugs = [`tags-${Date.now()}`, `tags-other-${Date.now()}`];
  let ctx: ActorContext;
  let otherCtx: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const a = await createOrganization(db, user, { name: "Tags Org", slug: slugs[0] });
    const b = await createOrganization(db, user, { name: "Other Org", slug: slugs[1] });
    ctx = { orgId: a.organization.id, actorId: a.actor.id, role: "owner", source: "ui" };
    otherCtx = { orgId: b.organization.id, actorId: b.actor.id, role: "owner", source: "ui" };
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
  });

  afterAll(async () => {
    for (const slug of slugs) await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("create, list (by name), unique per organization; members create, only admins delete", async () => {
    const bug = await createTag(db, ctx, { name: "bug", color: "#ef4444" });
    await createTag(db, { ...ctx, role: "member" }, { name: "agent" });
    expect((await listTags(db, ctx.orgId)).map((t) => t.name)).toEqual(["agent", "bug"]);
    await expect(createTag(db, ctx, { name: "bug" })).rejects.toMatchObject({ code: "conflict" });
    await expect(createTag(db, ctx, { name: "x", color: "red" })).rejects.toMatchObject({ code: "validation" });
    await expect(deleteTag(db, { ...ctx, role: "member" }, bug.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createTag(db, { ...ctx, role: "guest" }, { name: "nope" })).rejects.toMatchObject({ code: "forbidden" });
  });

  test("names are unique regardless of case; malformed ids are not found", async () => {
    await expect(createTag(db, ctx, { name: "BUG" })).rejects.toMatchObject({ code: "conflict" });
    const results = await Promise.allSettled([createTag(db, ctx, { name: "Race" }), createTag(db, ctx, { name: "race" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    await expect(deleteTag(db, ctx, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    const race = (await listTags(db, ctx.orgId)).find((t) => t.name.toLowerCase() === "race");
    if (race) await deleteTag(db, ctx, race.id);
  });

  test("tasks carry tags; changes are tracked; other orgs' tags are refused; deleting a tag untags", async () => {
    const [agent, bug] = await listTags(db, ctx.orgId);
    if (!agent || !bug) throw new Error("expected the tags from the previous test");
    const task = await createTask(db, ctx, "SPI", { title: "Tagged", tagIds: [bug.id] });
    expect(task.tagIds).toEqual([bug.id]);

    const updated = await updateTask(db, ctx, task.key, { tagIds: [agent.id, bug.id] });
    expect(updated.tagIds.sort()).toEqual([agent.id, bug.id].sort());
    expect((await listTasks(db, ctx.orgId, "SPI"))[0]?.tagIds.length).toBe(2);
    const log = await listTaskActivity(db, ctx.orgId, task.key);
    expect(log.at(-1)?.changes).toHaveProperty("tagIds");

    const foreign = await createTag(db, otherCtx, { name: "foreign" });
    await expect(updateTask(db, ctx, task.key, { tagIds: [foreign.id] })).rejects.toMatchObject({ code: "validation" });

    await deleteTag(db, ctx, bug.id);
    expect((await getTask(db, ctx.orgId, task.key)).tagIds).toEqual([agent.id]);
  });
});
