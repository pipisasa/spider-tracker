import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { createDocument, deleteDocument, editDocument, moveDocument, updateDocument } from "./documents";
import { listInbox, markInboxRead } from "./inbox";
import { createOrganization } from "./organizations";
import { getProjectRules, listProjectRules } from "./project-rules";
import { archiveProject, createProject, getProject, updateProject } from "./projects";
import { INBOX_KINDS } from "./schemas";
import { createTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("project rules for agents (ST-111)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `rules-${Date.now()}`;
  const people: string[] = [];
  let owner: ActorContext;
  let member: ActorContext;
  /** Scoped to RUL. */
  let worker: ActorContext;
  /** Scoped to OTH only. */
  let outsider: ActorContext;
  /** Sees every project. */
  let unscoped: ActorContext;
  /** An owner's agent: manages projects with its owner's rights. */
  let ownersAgent: ActorContext;

  const allKinds = { kinds: [...INBOX_KINDS] };
  const rulesItems = async (ctx: ActorContext) =>
    (await listInbox(db, ctx, { ...allKinds, unread: true })).filter((i) => i.kind === "rules");

  async function addPerson(role: ActorContext["role"], handle: string): Promise<ActorContext> {
    const id = `test-${crypto.randomUUID()}`;
    people.push(id);
    await db.insert(schema.user).values({ id, name: handle, email: `${id}@example.com` });
    const [actor] = await db
      .insert(schema.actors)
      .values({ orgId: owner.orgId, type: "human", userId: id, name: handle, handle, role })
      .returning();
    return { orgId: owner.orgId, actorId: actor?.id ?? "", role, source: "ui" };
  }

  async function agentOf(by: ActorContext, name: string, projectKeys?: string[]): Promise<ActorContext> {
    const { actor } = await createAgent(db, by, { name });
    if (projectKeys) {
      await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, actor.id));
      for (const key of projectKeys) {
        const project = await getProject(db, owner.orgId, key);
        await db.insert(schema.agentProjects).values({ agentId: actor.id, projectId: project.id });
      }
    }
    return { orgId: owner.orgId, actorId: actor.id, role: "member", source: "mcp" };
  }

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const user = { id: userId, name: "Owner", email: "owner@example.com" };
    const { organization, actor } = await createOrganization(db, user, { name: "Rules Org", slug });
    owner = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Rules", key: "RUL" });
    await createProject(db, owner, { name: "Other", key: "OTH" });
    member = await addPerson("member", "member");
    worker = await agentOf(member, "Worker", ["RUL"]);
    outsider = await agentOf(member, "Outsider", ["OTH"]);
    unscoped = await agentOf(member, "Everywhere");
    ownersAgent = await agentOf(owner, "Owner Bot", ["RUL"]);
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const id of [userId, ...people]) await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("setting the rules shows them to the project's agents and notifies them", async () => {
    const doc = await createDocument(db, owner, { title: "How we work", project: "RUL", content: "Reviews go to In Review." });
    const project = await updateProject(db, owner, "RUL", { rulesDocumentId: doc.id });
    expect(project.rulesDocumentId).toBe(doc.id);

    expect(await getProjectRules(db, worker, "RUL")).toMatchObject({
      projectKey: "RUL",
      documentId: doc.id,
      title: "How we work",
      content: "Reviews go to In Review.",
    });
    expect((await listProjectRules(db, worker)).map((r) => r.projectKey)).toEqual(["RUL"]);
    expect(await listProjectRules(db, outsider)).toEqual([]);
    expect(await getProjectRules(db, owner, "OTH")).toBeNull();

    // Agents that can see the project get a `rules` item; the actor, people and other projects' agents don't.
    for (const agent of [worker, unscoped, ownersAgent]) {
      expect(await rulesItems(agent)).toEqual([
        expect.objectContaining({
          kind: "rules",
          task: null,
          comment: null,
          document: { id: doc.id, title: "How we work", projectKey: "RUL" },
        }),
      ]);
    }
    expect(await rulesItems(outsider)).toEqual([]);
    expect(await rulesItems(member)).toEqual([]);
    expect(await rulesItems(owner)).toEqual([]);

    // Clients from before ST-111 don't ask for `rules` items and don't get them.
    expect((await listInbox(db, worker, { unread: true })).filter((i) => i.kind === "rules")).toEqual([]);
  });

  test("marking read up to an id leaves rules items alone unless asked (ST-128)", async () => {
    expect(await rulesItems(worker)).toHaveLength(1);
    // Clients from before ST-111 never fetch `rules` items, so their `upTo` must not mark them.
    await markInboxRead(db, worker, { upTo: Number.MAX_SAFE_INTEGER });
    expect(await rulesItems(worker)).toHaveLength(1);
    expect(await markInboxRead(db, worker, { upTo: Number.MAX_SAFE_INTEGER, kinds: ["rules"] })).toBe(1);
    expect(await rulesItems(worker)).toEqual([]);
    // Marking by id marks the item whatever its kind.
    const [item] = (await listInbox(db, unscoped, { ...allKinds, unread: true })).filter((i) => i.kind === "rules");
    expect(await markInboxRead(db, unscoped, { ids: [item?.id ?? 0] })).toBe(1);
  });

  test("saving the rules notifies once per unread item", async () => {
    const { rulesDocumentId } = await getProject(db, owner.orgId, "RUL");
    if (!rulesDocumentId) throw new Error("No rules");
    await markInboxRead(db, worker, { upTo: Number.MAX_SAFE_INTEGER, ...allKinds });

    const v1 = await updateDocument(db, owner, rulesDocumentId, { baseVersion: (await getProjectRules(db, owner, "RUL"))?.version, content: "v2" });
    expect(await rulesItems(worker)).toHaveLength(1);
    // Still unread: a second save adds nothing.
    await editDocument(db, owner, rulesDocumentId, { edits: [{ append: "more" }] });
    expect(await rulesItems(worker)).toHaveLength(1);
    // Saving without a change notifies nobody.
    await markInboxRead(db, worker, { upTo: Number.MAX_SAFE_INTEGER, ...allKinds });
    await updateDocument(db, owner, rulesDocumentId, { baseVersion: v1.version + 1, content: "v2\nmore" });
    expect(await rulesItems(worker)).toEqual([]);
  });

  test("only owners, admins and their agents set or change the rules", async () => {
    const { rulesDocumentId } = await getProject(db, owner.orgId, "RUL");
    if (!rulesDocumentId) throw new Error("No rules");
    const current = await getProjectRules(db, owner, "RUL");
    const baseVersion = current?.version ?? 0;

    await expect(updateProject(db, member, "RUL", { rulesDocumentId: null })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateProject(db, worker, "RUL", { rulesDocumentId: null })).rejects.toMatchObject({ code: "forbidden" });
    for (const ctx of [member, worker]) {
      await expect(updateDocument(db, ctx, rulesDocumentId, { baseVersion, content: "mine" })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(editDocument(db, ctx, rulesDocumentId, { edits: [{ append: "x" }] })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(moveDocument(db, ctx, rulesDocumentId, { project: null })).rejects.toMatchObject({ code: "forbidden" });
      await expect(deleteDocument(db, ctx, rulesDocumentId)).rejects.toMatchObject({ code: "forbidden" });
    }

    // Other documents of the project stay open to members.
    const other = await createDocument(db, member, { title: "Notes", project: "RUL" });
    expect(await updateDocument(db, worker, other.id, { baseVersion: 1, content: "fine" })).toMatchObject({ version: 2 });

    // An owner's agent may change them.
    expect(await updateDocument(db, ownersAgent, rulesDocumentId, { baseVersion, content: "by the bot" })).toMatchObject({
      version: baseVersion + 1,
    });
    expect(await rulesItems(worker)).toHaveLength(1);
  });

  test("the rules must be a document of the project itself", async () => {
    const task = await createTask(db, owner, "RUL", { title: "Has a doc" });
    const onTask = await createDocument(db, owner, { title: "Task doc", task: task.key });
    const orgWide = await createDocument(db, owner, { title: "Org doc" });
    const elsewhere = await createDocument(db, owner, { title: "Other doc", project: "OTH" });
    for (const doc of [onTask, orgWide, elsewhere]) {
      await expect(updateProject(db, owner, "RUL", { rulesDocumentId: doc.id })).rejects.toMatchObject({ code: "validation" });
    }
    await expect(updateProject(db, owner, "RUL", { rulesDocumentId: crypto.randomUUID() })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(updateProject(db, owner, "RUL", { rulesDocumentId: "nope" })).rejects.toMatchObject({ code: "validation" });
  });

  test("moving or deleting the rules document clears the project's rules", async () => {
    const moved = await createDocument(db, owner, { title: "Moving rules", project: "OTH" });
    await updateProject(db, owner, "OTH", { rulesDocumentId: moved.id });
    expect(await rulesItems(outsider)).toHaveLength(1);
    await moveDocument(db, owner, moved.id, { project: null });
    expect((await getProject(db, owner.orgId, "OTH")).rulesDocumentId).toBeNull();

    const deleted = await createDocument(db, owner, { title: "Deleted rules", project: "OTH" });
    await updateProject(db, owner, "OTH", { rulesDocumentId: deleted.id });
    await deleteDocument(db, owner, deleted.id);
    expect((await getProject(db, owner.orgId, "OTH")).rulesDocumentId).toBeNull();
    expect(await getProjectRules(db, outsider, "OTH")).toBeNull();
    // The notification about deleted rules goes away with them.
    expect((await rulesItems(outsider)).map((i) => i.document?.id)).not.toContain(deleted.id);
  });

  test("a rules item goes away once its document is no longer the rules (ST-128)", async () => {
    const first = await createDocument(db, owner, { title: "First rules", project: "OTH" });
    const second = await createDocument(db, owner, { title: "Second rules", project: "OTH" });
    const ids = async () => (await rulesItems(outsider)).map((i) => i.document?.id);

    await updateProject(db, owner, "OTH", { rulesDocumentId: first.id });
    expect(await ids()).toEqual([first.id]);
    // Replaced: only the new rules are announced.
    await updateProject(db, owner, "OTH", { rulesDocumentId: second.id });
    expect(await ids()).toEqual([second.id]);
    // Cleared: nothing is left.
    await updateProject(db, owner, "OTH", { rulesDocumentId: null });
    expect(await ids()).toEqual([]);
    // Moved to another project: no longer anyone's rules.
    await updateProject(db, owner, "OTH", { rulesDocumentId: first.id });
    expect(await ids()).toEqual([first.id]);
    await moveDocument(db, owner, first.id, { project: "RUL" });
    expect(await ids()).toEqual([]);
    expect((await rulesItems(unscoped)).map((i) => i.document?.id)).not.toContain(first.id);
  });

  test("archived projects' agents aren't told about rules changes (ST-128)", async () => {
    await createProject(db, owner, { name: "Old", key: "OLD" });
    const old = await agentOf(member, "Old Hand", ["OLD"]);
    const doc = await createDocument(db, owner, { title: "Old rules", project: "OLD" });
    await updateProject(db, owner, "OLD", { rulesDocumentId: doc.id });
    expect(await rulesItems(old)).toHaveLength(1);
    await markInboxRead(db, old, { upTo: Number.MAX_SAFE_INTEGER, ...allKinds });

    await archiveProject(db, owner, "OLD", true);
    await updateProject(db, owner, "OLD", { rulesDocumentId: null });
    await updateProject(db, owner, "OLD", { rulesDocumentId: doc.id });
    expect(await rulesItems(old)).toEqual([]);
    const all = await listInbox(db, old, { ...allKinds });
    expect(all.filter((i) => i.kind === "rules")).toHaveLength(1);
  });
});
