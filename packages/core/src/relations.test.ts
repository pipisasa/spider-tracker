import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { addRelation, listRelations, removeRelation } from "./relations";
import { createTask, deleteTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("task relations", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `relations-${Date.now()}`;
  let ctx: ActorContext;
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
});
