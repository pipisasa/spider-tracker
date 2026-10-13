import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { addComment } from "./comments";
import { EVENTS_CHANNEL, type OrgEvent } from "./events";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createTask, updateTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("change events", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `events-${Date.now()}`;
  let ctx: ActorContext;
  const received: OrgEvent[] = [];
  let unlisten: () => Promise<void>;

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await Bun.sleep(20);
  };
  const mine = () => received.filter((e) => e.orgId === ctx.orgId);

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: user.id,
      name: user.name,
      email: `${user.id}@example.com`,
    });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Events Org",
      slug,
    });
    ctx = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    // Other test files share the database, so filter by this organization.
    const listener = await db.$client.listen(EVENTS_CHANNEL, (payload) =>
      received.push(JSON.parse(payload) as OrgEvent),
    );
    unlisten = listener.unlisten;
  });

  afterAll(async () => {
    await unlisten();
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("committed writes publish small events", async () => {
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    await createTask(db, ctx, "SPI", {
      title: "Live",
      assigneeIds: [ctx.actorId],
    });
    await updateTask(db, ctx, "SPI-1", { title: "Live!" });
    await addComment(db, ctx, "SPI-1", { body: "hello" });
    await until(() => mine().length >= 4);
    expect(mine().map((e) => e.type)).toEqual([
      "project.changed",
      "task.changed",
      "task.changed",
      "comment.created",
    ]);
    expect(mine()[1]).toEqual({
      type: "task.changed",
      orgId: ctx.orgId,
      projectKey: "SPI",
      taskKey: "SPI-1",
    });
  });

  test("a rolled-back write publishes nothing", async () => {
    const before = mine().length;
    await expect(
      createTask(db, ctx, "SPI", {
        title: "x",
        assigneeIds: [crypto.randomUUID()],
      }),
    ).rejects.toThrow();
    await Bun.sleep(200);
    expect(mine().length).toBe(before);
  });
});
