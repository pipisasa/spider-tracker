import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createTask, getTask, listSubtasks, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("sub-tasks", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `subtasks-${Date.now()}`;
  let ctx: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Sub Org", slug });
    ctx = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    await createProject(db, ctx, { name: "Web", key: "WEB" });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("children carry parentKey and are listed under the parent, across projects", async () => {
    const epic = await createTask(db, ctx, "SPI", { title: "Epic" });
    const child = await createTask(db, ctx, "SPI", { title: "Child", parentId: epic.id });
    const other = await createTask(db, ctx, "WEB", { title: "Web part", parentId: epic.id });
    expect(child.parentKey).toBe("SPI-1");
    expect((await getTask(db, ctx.orgId, other.key)).parentKey).toBe("SPI-1");
    expect((await listSubtasks(db, ctx.orgId, "SPI-1")).map((t) => t.key)).toEqual(["SPI-2", "WEB-1"]);
    expect((await getTask(db, ctx.orgId, "SPI-1")).parentKey).toBeNull();
  });

  test("no cycles: not itself, not a descendant", async () => {
    const grandchild = await createTask(db, ctx, "SPI", { title: "Grandchild", parentId: (await getTask(db, ctx.orgId, "SPI-2")).id });
    await expect(updateTask(db, ctx, "SPI-1", { parentId: grandchild.id })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("sub-task of this one"),
    });
    const self = await getTask(db, ctx.orgId, "SPI-2");
    await expect(updateTask(db, ctx, "SPI-2", { parentId: self.id })).rejects.toMatchObject({ code: "validation" });

    // Moving a sub-tree elsewhere is fine; clearing the parent too.
    const moved = await updateTask(db, ctx, "SPI-2", { parentId: (await getTask(db, ctx.orgId, "WEB-1")).id });
    expect(moved.parentKey).toBe("WEB-1");
    expect((await updateTask(db, ctx, "SPI-2", { parentId: null })).parentKey).toBeNull();
  });
});
