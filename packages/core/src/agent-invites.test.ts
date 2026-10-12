import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  holdLock,
  settle,
  waitForLockWaiters,
} from "./test-locks.test-utils";
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

  /** Accepts two invites at once: both pick their handle, then queue on their locked agents. */
  async function acceptBothAtOnce(input: { name: string; handle?: string }) {
    const invites = await Promise.all([
      createAgentInvite(db, owner, { projectKeys: ["ST"] }),
      createAgentInvite(db, owner, { projectKeys: ["ST"] }),
    ]);
    const ids = invites.map((i) => i.agent.id);
    const release = await holdLock(
      db,
      sql`select 1 from ${schema.actors} where ${inArray(schema.actors.id, ids)} for update`,
    );
    const accepting = invites.map((i) =>
      acceptAgentInvite(db, { code: i.invite.code, ...input }),
    );
    const results = accepting.map(settle);
    await waitForLockWaiters(db, '"actors"', 2);
    await release();
    const errors = await Promise.all(results);
    const handles = (
      await db
        .select({ handle: schema.actors.handle })
        .from(schema.actors)
        .where(inArray(schema.actors.id, ids))
    ).map((a) => a.handle);
    return { errors, handles };
  }

  test("two agents named alike accepting at once get distinct handles", async () => {
    const { errors, handles } = await acceptBothAtOnce({ name: "Racer Bot" });
    expect(errors).toEqual([null, null]);
    expect(handles.sort()).toEqual(["racer-bot", "racer-bot-2"]);
  });

  test("two agents asking for the same handle at once: one gets a conflict", async () => {
    const { errors, handles } = await acceptBothAtOnce({
      name: "Twin Bot",
      handle: "twin",
    });
    expect(errors.filter((e) => e === null)).toHaveLength(1);
    expect(errors.find((e) => e !== null)).toMatchObject({ code: "conflict" });
    expect(handles.filter((h) => h === "twin")).toHaveLength(1);
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

  test("a scoped agent whose projects are all deleted sees nothing, not everything", async () => {
    await createProject(db, owner, { name: "Going", key: "GO" });
    await createTask(db, owner, "GO", { title: "Soon gone" });
    await createDocument(db, owner, { title: "Still org-wide", content: "x" });
    const { invite } = await createAgentInvite(db, owner, {
      projectKeys: ["GO"],
    });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const ctx = () => agentCtx(actor.id);
    expect((await listProjects(db, ctx())).map((p) => p.key)).toEqual(["GO"]);

    // Cascades to the agent's agent_projects row.
    await db
      .delete(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, owner.orgId),
          eq(schema.projects.key, "GO"),
        ),
      );

    expect(await listProjects(db, ctx())).toEqual([]);
    expect(await listTasks(db, ctx(), "ST")).toEqual([]);
    await expect(getProject(db, ctx(), "ST")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      createTask(db, ctx(), "ST", { title: "Nope" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await scopedProjectKeys(db, ctx())).toEqual(new Set());
    const docs = (await listDocuments(db, ctx())).map((d) => d.title);
    expect(docs).toContain("Still org-wide");
    expect(docs).not.toContain("XY doc");
    expect(
      (await listAgents(db, owner)).find((a) => a.actor.id === actor.id)
        ?.projects,
    ).toEqual([]);

    // People and unscoped agents still see every project.
    const free = await createAgent(db, owner, { name: "Still Free Bot" });
    expect(
      (await listProjects(db, agentCtx(free.actor.id))).map((p) => p.key),
    ).toEqual(["ST", "XY"]);
    expect((await listProjects(db, owner)).map((p) => p.key)).toEqual([
      "ST",
      "XY",
    ]);
    expect(
      (await listAgents(db, owner)).find((a) => a.actor.id === free.actor.id)
        ?.projects,
    ).toBeNull();
  });

  test("an invite whose projects were all deleted can't be accepted", async () => {
    await createProject(db, owner, { name: "Vanishing", key: "VN" });
    const { invite } = await createAgentInvite(db, owner, {
      projectKeys: ["VN"],
    });
    await db
      .delete(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, owner.orgId),
          eq(schema.projects.key, "VN"),
        ),
      );
    await expect(
      acceptAgentInvite(db, { code: invite.code }),
    ).rejects.toMatchObject({
      code: "validation",
      message: "The projects this invite was for no longer exist; ask for a new invite",
    });
    // Still unused, so it can be revoked.
    expect((await listAgentInvites(db, owner)).map((i) => i.id)).toContain(
      invite.id,
    );
    await revokeAgentInvite(db, owner, invite.id);
  });

  test("project rows scope an agent even without the scoped flag", async () => {
    const { invite } = await createAgentInvite(db, owner, {
      projectKeys: ["ST"],
    });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    await db
      .update(schema.agents)
      .set({ scoped: false })
      .where(eq(schema.agents.actorId, actor.id));
    expect(
      (await listProjects(db, agentCtx(actor.id))).map((p) => p.key),
    ).toEqual(["ST"]);
  });

  test("a parent outside the agent's scope has no key", async () => {
    const parent = await createTask(db, owner, "XY", { title: "Out parent" });
    const child = await createTask(db, owner, "ST", {
      title: "In child",
      parentId: parent.id,
    });
    expect(child.parentKey).toBe(parent.key);
    const { invite } = await createAgentInvite(db, owner, {
      projectKeys: ["ST"],
    });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const ctx = () => agentCtx(actor.id);

    expect(await getTask(db, ctx(), child.key)).toMatchObject({
      parentKey: null,
      parentId: null,
    });
    expect(
      (await listTasks(db, ctx(), "ST")).find((t) => t.key === child.key),
    ).toMatchObject({ parentKey: null, parentId: null });
    expect(
      await updateTask(db, ctx(), child.key, { title: "Renamed child" }),
    ).toMatchObject({ parentKey: null, parentId: null });
    expect(await getTask(db, owner, child.key)).toMatchObject({
      parentKey: parent.key,
      parentId: parent.id,
    });

    // A parent in scope keeps both.
    const inParent = await createTask(db, owner, "ST", { title: "In parent" });
    const inChild = await createTask(db, owner, "ST", {
      title: "In child 2",
      parentId: inParent.id,
    });
    expect(await getTask(db, ctx(), inChild.key)).toMatchObject({
      parentKey: inParent.key,
      parentId: inParent.id,
    });
  });

  test("pending agents whose invite expired over 7 days ago are cleaned up", async () => {
    const stale = await createAgentInvite(db, owner, { projectKeys: ["ST"] });
    const recent = await createAgentInvite(db, owner, { projectKeys: ["ST"] });
    const day = 24 * 60 * 60 * 1000;
    await db
      .update(schema.agentInvites)
      .set({ expiresAt: new Date(Date.now() - 8 * day) })
      .where(eq(schema.agentInvites.id, stale.invite.id));
    await db
      .update(schema.agentInvites)
      .set({ expiresAt: new Date(Date.now() - day) })
      .where(eq(schema.agentInvites.id, recent.invite.id));

    const listed = (await listAgentInvites(db, owner)).map((i) => i.id);
    expect(listed).not.toContain(stale.invite.id);
    expect(listed).toContain(recent.invite.id);
    const agentRows = async (id: string) =>
      db.select().from(schema.actors).where(eq(schema.actors.id, id));
    // Listing only hides it; the next invite removes it and records who did.
    expect(await agentRows(stale.agent.id)).toHaveLength(1);
    const next = await createAgentInvite(db, owner, { projectKeys: ["ST"] });
    expect(await agentRows(stale.agent.id)).toHaveLength(0);
    expect(await agentRows(recent.agent.id)).toHaveLength(1);
    const purged = await db
      .select()
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.entityId, stale.agent.id),
          eq(schema.activity.action, "agent_invite.purged"),
        ),
      );
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({
      actorId: owner.actorId,
      changes: { inviteId: stale.invite.id },
    });
    await revokeAgentInvite(db, owner, recent.invite.id);
    await revokeAgentInvite(db, owner, next.invite.id);
  });
});
