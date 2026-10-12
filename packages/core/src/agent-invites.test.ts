import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import {
  acceptAgentInvite,
  createAgentInvite,
  listAgentInvites,
  normalizeAgentInviteCode,
  revokeAgentInvite,
} from "./agent-invites";
import {
  authenticateApiKey,
  createAgent,
  listAgents,
  updateAgent,
} from "./agents";
import { addComment, listComments } from "./comments";
import { createDocument, getDocument, listDocuments } from "./documents";
import { eventInScope, scopedProjectKeys } from "./events";
import { listInbox } from "./inbox";
import { listMembers } from "./organizations";
import { createOrganization } from "./organizations";
import { createProject, getProject, listProjects } from "./projects";
import { addRelation, listRelations } from "./relations";
import {
  createTask,
  getTask,
  listSubtasks,
  listTasks,
  updateTask,
} from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

test("normalises codes and invite links", () => {
  expect(normalizeAgentInviteCode(" abcd-efgh ")).toBe("ABCDEFGH");
  expect(
    normalizeAgentInviteCode("https://spider.example/agent-invite/ABCD-EFGH"),
  ).toBe("ABCDEFGH");
  expect(
    normalizeAgentInviteCode("https://spider.example/agent-invite/ABCD-EFGH/"),
  ).toBe("ABCDEFGH");
  expect(
    normalizeAgentInviteCode("https://spider.example/join?code=abcd-efgh&x=1"),
  ).toBe("ABCDEFGH");
});

test("events outside a scope are filtered", () => {
  const keys = new Set(["ST"]);
  expect(
    eventInScope(
      { type: "task.changed", orgId: "o", projectKey: "XY", taskKey: "XY-1" },
      keys,
    ),
  ).toBe(false);
  expect(
    eventInScope(
      { type: "comment.created", orgId: "o", taskKey: "ST-2" },
      keys,
    ),
  ).toBe(true);
  expect(
    eventInScope(
      { type: "comment.created", orgId: "o", taskKey: "XY-2" },
      keys,
    ),
  ).toBe(false);
  expect(
    eventInScope(
      {
        type: "document.changed",
        orgId: "o",
        documentId: "d",
        projectKey: null,
        taskKey: null,
      },
      keys,
    ),
  ).toBe(true);
  expect(
    eventInScope(
      { type: "task.changed", orgId: "o", projectKey: "XY", taskKey: "XY-1" },
      null,
    ),
  ).toBe(true);
});

run("agent invites and project scope", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `agent-invites-${Date.now()}`;
  let owner: ActorContext;

  /** A fresh context per call, like one per request. */
  const agentCtx = (actorId: string): ActorContext => ({
    orgId: owner.orgId,
    actorId,
    role: "member",
    source: "api",
  });

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({
        id: user.id,
        name: user.name,
        email: `${user.id}@example.com`,
      });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Invites Org",
      slug,
    });
    owner = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Secret", key: "XY" });
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("an invite creates a hidden pending agent; accepting activates it with a key", async () => {
    const { invite, agent } = await createAgentInvite(db, owner, {
      projectKeys: ["st"],
      expiresInDays: 1,
    });
    expect(invite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(invite.projects).toEqual([{ key: "ST", name: "Spider" }]);
    expect(agent.handle).toMatch(/^agent-[a-z2-9]{4}$/);

    expect(
      (await listMembers(db, owner.orgId)).some((m) => m.id === agent.id),
    ).toBe(false);
    expect(
      (await listAgents(db, owner)).some((a) => a.actor.id === agent.id),
    ).toBe(false);
    expect((await listAgentInvites(db, owner)).map((i) => i.id)).toContain(
      invite.id,
    );

    // A taken handle fails without using up the code.
    await expect(
      acceptAgentInvite(db, { code: invite.code, handle: "owner" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const accepted = await acceptAgentInvite(db, {
      code: `https://spider.example/agent-invite/${invite.code.toLowerCase()}`,
      name: "Builder Bot",
      description: "Builds things",
    });
    expect(accepted.token).toStartWith("spt_");
    expect(accepted.actor).toMatchObject({
      id: agent.id,
      name: "Builder Bot",
      handle: "builder-bot",
    });
    expect(accepted.organization.slug).toBe(slug);
    expect(accepted.projects).toEqual([{ key: "ST", name: "Spider" }]);
    expect(accepted.owner.id).toBe(owner.actorId);
    expect((await authenticateApiKey(db, accepted.token))?.actor.id).toBe(
      agent.id,
    );

    const listed = (await listAgents(db, owner)).find(
      (a) => a.actor.id === agent.id,
    );
    expect(listed).toMatchObject({
      description: "Builds things",
      projects: [{ key: "ST", name: "Spider" }],
    });
    expect((await listAgentInvites(db, owner)).map((i) => i.id)).not.toContain(
      invite.id,
    );

    await expect(acceptAgentInvite(db, { code: invite.code })).rejects.toThrow(
      "Invalid or expired invitation code",
    );
    await expect(
      acceptAgentInvite(db, { code: "ZZZZ-ZZZZ" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  test("expired invites are rejected; revoking removes the pending agent", async () => {
    const { invite, agent } = await createAgentInvite(db, owner, {
      projectKeys: ["ST"],
    });
    await db
      .update(schema.agentInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.agentInvites.id, invite.id));
    await expect(
      acceptAgentInvite(db, { code: invite.code }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(
      (await listAgentInvites(db, owner)).find((i) => i.id === invite.id)
        ?.status,
    ).toBe("expired");

    await revokeAgentInvite(db, owner, invite.id);
    expect(
      await db
        .select()
        .from(schema.actors)
        .where(eq(schema.actors.id, agent.id)),
    ).toHaveLength(0);
    await expect(revokeAgentInvite(db, owner, invite.id)).rejects.toMatchObject(
      { code: "not_found" },
    );
  });

  test("invites need existing projects and a person who can create agents", async () => {
    await expect(
      createAgentInvite(db, owner, { projectKeys: ["NOPE"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createAgentInvite(db, owner, { projectKeys: [] }),
    ).rejects.toMatchObject({ code: "validation" });
    const bot = await createAgent(db, owner, { name: "Inviter Bot" });
    await expect(
      createAgentInvite(db, agentCtx(bot.actor.id), { projectKeys: ["ST"] }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("an agent may update its own name, handle and description", async () => {
    const bot = await createAgent(db, owner, { name: "Self Bot" });
    const updated = await updateAgent(
      db,
      agentCtx(bot.actor.id),
      bot.actor.id,
      { name: "Renamed", handle: "renamed-bot" },
    );
    expect(updated.actor).toMatchObject({
      name: "Renamed",
      handle: "renamed-bot",
    });
    const other = await createAgent(db, owner, { name: "Other Bot" });
    await expect(
      updateAgent(db, agentCtx(bot.actor.id), other.actor.id, {
        name: "Hijack",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("a scoped agent sees only its projects, everywhere", async () => {
    const st = await createTask(db, owner, "ST", { title: "In scope" });
    const xy = await createTask(db, owner, "XY", { title: "Out of scope" });
    const stChild = await createTask(db, owner, "ST", {
      title: "Child",
      parentId: st.id,
    });
    await createTask(db, owner, "XY", {
      title: "Hidden child",
      parentId: st.id,
    });
    await addRelation(db, owner, st.key, { kind: "relates", task: xy.key });
    await createDocument(db, owner, {
      title: "Org doc",
      format: "md",
      content: "x",
    });
    const xyDoc = await createDocument(db, owner, {
      title: "XY doc",
      format: "md",
      content: "x",
      project: "XY",
    });

    const { invite } = await createAgentInvite(db, owner, {
      projectKeys: ["ST"],
    });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const ctx = () => agentCtx(actor.id);

    expect((await listProjects(db, ctx())).map((p) => p.key)).toEqual(["ST"]);
    await expect(getProject(db, ctx(), "XY")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await listTasks(db, ctx(), "XY")).toEqual([]);
    expect((await listTasks(db, ctx(), "ST")).map((t) => t.key)).toContain(
      st.key,
    );
    await expect(getTask(db, ctx(), xy.key)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      updateTask(db, ctx(), xy.key, { title: "Nope" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createTask(db, ctx(), "XY", { title: "Nope" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createTask(db, ctx(), "ST", { title: "Nope", parentId: xy.id }),
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(listComments(db, ctx(), xy.key)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      addRelation(db, ctx(), st.key, { kind: "blocks", task: xy.key }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await listRelations(db, ctx(), st.key)).toEqual([]);
    expect((await listSubtasks(db, ctx(), st.key)).map((t) => t.key)).toEqual([
      stChild.key,
    ]);

    const docs = (await listDocuments(db, ctx())).map((d) => d.title);
    expect(docs).toContain("Org doc");
    expect(docs).not.toContain("XY doc");
    await expect(getDocument(db, ctx(), xyDoc.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      createDocument(db, ctx(), {
        title: "No",
        format: "md",
        content: "x",
        project: "XY",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await scopedProjectKeys(db, ctx())).toEqual(new Set(["ST"]));

    // Inbox: mentions on out-of-scope tasks are not delivered.
    await addComment(db, owner, xy.key, { body: `@${actor.handle} secret` });
    await addComment(db, owner, st.key, { body: `@${actor.handle} visible` });
    expect((await listInbox(db, ctx())).map((i) => i.task.key)).toEqual([
      st.key,
    ]);

    // Unscoped agents are unchanged.
    const free = await createAgent(db, owner, { name: "Free Bot" });
    expect(
      (await listProjects(db, agentCtx(free.actor.id))).map((p) => p.key),
    ).toEqual(["ST", "XY"]);
    expect((await getTask(db, agentCtx(free.actor.id), xy.key)).key).toBe(
      xy.key,
    );
    expect(await scopedProjectKeys(db, agentCtx(free.actor.id))).toBeNull();
  });
});
