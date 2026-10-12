import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { AGENT_COMMENT_LIMIT, addComment, listComments, parseMentions } from "./comments";
import { listInbox, markInboxRead } from "./inbox";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createTask, updateTask } from "./tasks";

describe("parseMentions", () => {
  test("finds handles, ignores emails and duplicates", () => {
    expect(parseMentions("@claude-code please ask @Alice; mail bob@example.com, @claude-code again")).toEqual([
      "claude-code",
      "alice",
    ]);
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("comments, inbox and loop guards", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `comments-${Date.now()}`;
  let owner: ActorContext;
  let alpha: ActorContext;
  let beta: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Comments Org", slug });
    owner = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    const a = await createAgent(db, owner, { name: "Alpha" });
    const b = await createAgent(db, owner, { name: "Beta" });
    alpha = { orgId: organization.id, actorId: a.actor.id, role: "member", source: "mcp" };
    beta = { orgId: organization.id, actorId: b.actor.id, role: "member", source: "mcp" };
    await createProject(db, owner, { name: "Spider", key: "SPI" });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("assignment and mentions land in the right inboxes", async () => {
    await createTask(db, owner, "SPI", { title: "Ship it", assigneeIds: [alpha.actorId] });
    expect((await listInbox(db, alpha)).map((i) => i.kind)).toEqual(["assigned"]);

    const comment = await addComment(db, owner, "SPI-1", { body: "@alpha can you ask @beta for a review?" });
    const alphaInbox = await listInbox(db, alpha);
    // Alpha is both assigned and mentioned: one item, as a mention.
    expect(alphaInbox.map((i) => i.kind)).toEqual(["assigned", "mention"]);
    expect(alphaInbox[1]).toMatchObject({
      task: { key: "SPI-1", title: "Ship it" },
      comment: { id: comment.id },
      from: { type: "human" },
    });
    expect((await listInbox(db, beta)).map((i) => i.kind)).toEqual(["mention"]);
    expect(await listInbox(db, owner)).toEqual([]);

    // A reply notifies the parent's author; the cursor returns only newer items.
    const cursor = (await listInbox(db, owner)).at(-1)?.id ?? 0;
    await addComment(db, alpha, "SPI-1", { body: "On it", parentId: comment.id });
    const ownerInbox = await listInbox(db, owner, { after: cursor });
    expect(ownerInbox.map((i) => [i.kind, i.from.handle])).toEqual([["reply", "alpha"]]);

    expect(await markInboxRead(db, alpha, { upTo: alphaInbox[1]?.id })).toBe(2);
    expect(await listInbox(db, alpha, { unread: "true" })).toEqual([]);
    expect((await listInbox(db, alpha, { unread: "false" })).length).toBe(2);
  });

  test("reassigning notifies only the newly added assignee", async () => {
    const before = (await listInbox(db, beta)).length;
    await updateTask(db, owner, "SPI-1", { assigneeIds: [alpha.actorId, beta.actorId] });
    const after = await listInbox(db, beta);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.kind).toBe("assigned");
  });

  test("agents are limited per minute, but agent-only threads can go on (ST-102)", async () => {
    await createTask(db, owner, "SPI", { title: "Chatty" });
    for (let i = 0; i < AGENT_COMMENT_LIMIT.perMinute; i++) await addComment(db, alpha, "SPI-2", { body: `ping ${i}` });
    await expect(addComment(db, alpha, "SPI-2", { body: "one more" })).rejects.toMatchObject({ code: "rate_limited" });

    // The limit is per agent; a long agent-only thread no longer waits for a person.
    for (let i = 0; i < AGENT_COMMENT_LIMIT.perMinute; i++) await addComment(db, beta, "SPI-2", { body: `pong ${i}` });
    expect((await listComments(db, owner.orgId, "SPI-2")).length).toBe(2 * AGENT_COMMENT_LIMIT.perMinute);
  });

  test("guests can't comment; parents must be on the same task", async () => {
    await expect(addComment(db, { ...owner, role: "guest" }, "SPI-1", { body: "hi" })).rejects.toMatchObject({
      code: "forbidden",
    });
    const [onOther] = await listComments(db, owner.orgId, "SPI-2");
    await expect(addComment(db, owner, "SPI-1", { body: "x", parentId: onOther?.id })).rejects.toMatchObject({
      code: "validation",
    });
  });
});
