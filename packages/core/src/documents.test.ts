import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, desc, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { acceptAgentInvite, createAgentInvite } from "./agent-invites";
import { createAgent } from "./agents";
import {
  createDocument,
  deleteDocument,
  editDocument,
  getDocument,
  getDocumentVersion,
  listDocuments,
  listDocumentVersions,
  moveDocument,
  updateDocument,
} from "./documents";
import { createOrganization } from "./organizations";
import { archiveProject, createProject } from "./projects";
import { createTask, deleteTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("documents", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `documents-${Date.now()}`;
  let ctx: ActorContext;

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({
        id: user.id,
        name: user.name,
        email: `${user.id}@example.com`,
      });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Docs Org",
      slug,
    });
    ctx = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, ctx, { name: "Spider", key: "SPI" });
    await createProject(db, ctx, { name: "Other", key: "OTH" });
    await createTask(db, ctx, "SPI", { title: "API" });
    await createTask(db, ctx, "SPI", { title: "Gone" });
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("creates at organization, project and task level; a task implies its project", async () => {
    const org = await createDocument(db, ctx, {
      title: "Handbook",
      content: "# Hi",
    });
    expect(org).toMatchObject({
      projectKey: null,
      taskKey: null,
      format: "md",
      version: 1,
      content: "# Hi",
    });
    const project = await createDocument(db, ctx, {
      title: "Spec",
      project: "spi",
      format: "html",
      content: "<p>x</p>",
    });
    expect(project).toMatchObject({
      projectKey: "SPI",
      taskKey: null,
      format: "html",
    });
    const task = await createDocument(db, ctx, {
      title: "Notes",
      task: "spi-1",
    });
    expect(task).toMatchObject({
      projectKey: "SPI",
      taskKey: "SPI-1",
      content: "",
    });

    await expect(
      createDocument(db, ctx, { title: "X", task: "SPI-1", project: "OTH" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      createDocument(db, ctx, { title: "X", project: "NOPE" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(createDocument(db, ctx, { title: " " })).rejects.toMatchObject(
      { code: "validation" },
    );
    await expect(
      createDocument(db, ctx, { title: "Big", content: "x".repeat(1_000_001) }),
    ).rejects.toMatchObject({
      code: "validation",
    });

    const titles = async (query: object) =>
      (await listDocuments(db, ctx.orgId, query)).map((d) => d.title).sort();
    expect(await titles({})).toEqual(["Handbook", "Notes", "Spec"]);
    expect(await titles({ project: "SPI" })).toEqual(["Notes", "Spec"]);
    expect(await titles({ task: "SPI-1" })).toEqual(["Notes"]);
    expect(await titles({ project: "OTH" })).toEqual([]);
    expect((await listDocuments(db, ctx.orgId))[0]).not.toHaveProperty(
      "content",
    );
  });

  test("updates need the current version, skip no-ops and keep every version", async () => {
    const doc = await createDocument(db, ctx, {
      title: "Plan",
      project: "SPI",
      content: "v1",
    });
    const v2 = await updateDocument(db, ctx, doc.id, {
      baseVersion: 1,
      content: "v2",
    });
    expect(v2).toMatchObject({ version: 2, content: "v2", title: "Plan" });

    await expect(
      updateDocument(db, ctx, doc.id, { baseVersion: 1, content: "stale" }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      (
        await updateDocument(db, ctx, doc.id, {
          baseVersion: 2,
          content: "v2",
          title: "Plan",
        })
      ).version,
    ).toBe(2);

    const v3 = await updateDocument(db, ctx, doc.id, {
      baseVersion: 2,
      title: "Plan B",
      format: "html",
    });
    expect(v3).toMatchObject({
      version: 3,
      title: "Plan B",
      format: "html",
      content: "v2",
    });

    expect(
      (await listDocumentVersions(db, ctx.orgId, doc.id)).map((v) => [
        v.version,
        v.title,
      ]),
    ).toEqual([
      [3, "Plan B"],
      [2, "Plan"],
      [1, "Plan"],
    ]);
    expect(await getDocumentVersion(db, ctx.orgId, doc.id, 1)).toMatchObject({
      content: "v1",
      format: "md",
    });
    await expect(
      getDocumentVersion(db, ctx.orgId, doc.id, 9),
    ).rejects.toMatchObject({ code: "not_found" });

    const activity = await db
      .select({ action: schema.activity.action })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.entityType, "document"),
          eq(schema.activity.entityId, doc.id),
        ),
      );
    expect(activity.map((a) => a.action)).toEqual([
      "document.created",
      "document.updated",
      "document.updated",
    ]);
  });

  test("concurrent saves from the same version: one wins, the other conflicts", async () => {
    const doc = await createDocument(db, ctx, { title: "Race" });
    const results = await Promise.allSettled([
      updateDocument(db, ctx, doc.id, { baseVersion: 1, content: "a" }),
      updateDocument(db, ctx, doc.id, { baseVersion: 1, content: "b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getDocument(db, ctx.orgId, doc.id)).version).toBe(2);
  });

  test("partial edits save a new version each and check baseVersion when given", async () => {
    const doc = await createDocument(db, ctx, {
      title: "Edits",
      content: "# Edits\n\nIntro.\n\n## Решения\n\nOld.\n\n## Next\n\nLater.\n",
    });
    const v2 = await editDocument(db, ctx, doc.id, { edits: [{ old: "Intro.", new: "Hello." }] });
    expect(v2).toMatchObject({ version: 2, content: expect.stringContaining("Hello.") });

    const v3 = await editDocument(db, ctx, doc.id, {
      baseVersion: 2,
      edits: [{ section: "## Решения", content: "New." }, { append: "See [[Plan]]." }],
    });
    expect(v3.version).toBe(3);
    expect(v3.content).toBe("# Edits\n\nHello.\n\n## Решения\n\nNew.\n\n## Next\n\nLater.\nSee [[Plan]].");
    const links = await db
      .select({ target: schema.documentLinks.target })
      .from(schema.documentLinks)
      .where(eq(schema.documentLinks.documentId, doc.id));
    expect(links.map((l) => l.target)).toEqual(["Plan"]);

    await expect(
      editDocument(db, ctx, doc.id, { baseVersion: 2, edits: [{ append: "stale" }] }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("version 3") });
    await expect(
      editDocument(db, ctx, doc.id, { edits: [{ old: "Intro.", new: "x" }] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      editDocument(db, ctx, doc.id, { edits: [{ append: "ok" }, { old: "missing", new: "x" }] }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Edit 2") });
    await expect(editDocument(db, ctx, doc.id, { edits: [] })).rejects.toMatchObject({ code: "validation" });
    await expect(
      editDocument(db, ctx, doc.id, { edits: [{ old: "a", new: "b", append: "c" }] }),
    ).rejects.toMatchObject({ code: "validation" });
    // A no-op edit keeps the version.
    expect((await editDocument(db, ctx, doc.id, { edits: [{ old: "New.", new: "New." }] })).version).toBe(3);

    expect((await listDocumentVersions(db, ctx.orgId, doc.id)).map((v) => v.version)).toEqual([3, 2, 1]);
    const [activity] = await db
      .select({ changes: schema.activity.changes })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.entityType, "document"),
          eq(schema.activity.entityId, doc.id),
          eq(schema.activity.action, "document.updated"),
        ),
      )
      .orderBy(desc(schema.activity.id))
      .limit(1);
    expect(activity?.changes).toMatchObject({ version: [2, 3], fields: ["content"], edits: ["section", "append"] });
  });

  test("concurrent partial edits without baseVersion both apply", async () => {
    const doc = await createDocument(db, ctx, { title: "Shared", content: "a\nb\n" });
    await Promise.all([
      editDocument(db, ctx, doc.id, { edits: [{ old: "a", new: "A" }] }),
      editDocument(db, ctx, doc.id, { edits: [{ old: "b", new: "B" }] }),
    ]);
    expect(await getDocument(db, ctx.orgId, doc.id)).toMatchObject({ version: 3, content: "A\nB\n" });
  });

  test("an edit can't push a document over 1 MB", async () => {
    const doc = await createDocument(db, ctx, { title: "Big", content: "x".repeat(999_990) });
    await expect(
      editDocument(db, ctx, doc.id, { edits: [{ append: "y".repeat(20) }] }),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("1 MB") });
  });

  test("guests read but can't write", async () => {
    const doc = await createDocument(db, ctx, { title: "Read me" });
    const guest: ActorContext = { ...ctx, role: "guest" };
    expect((await getDocument(db, guest.orgId, doc.id)).title).toBe("Read me");
    await expect(
      createDocument(db, guest, { title: "No" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      updateDocument(db, guest, doc.id, { baseVersion: 1, content: "no" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      editDocument(db, guest, doc.id, { edits: [{ append: "no" }] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteDocument(db, guest, doc.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("deleted documents and documents of deleted tasks disappear", async () => {
    const doc = await createDocument(db, ctx, { title: "Temp" });
    await deleteDocument(db, ctx, doc.id);
    await expect(getDocument(db, ctx.orgId, doc.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      getDocument(db, ctx.orgId, "not-a-uuid"),
    ).rejects.toMatchObject({ code: "not_found" });

    const onTask = await createDocument(db, ctx, {
      title: "On gone task",
      task: "SPI-2",
    });
    await deleteTask(db, ctx, "SPI-2");
    await expect(getDocument(db, ctx.orgId, onTask.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      (await listDocuments(db, ctx.orgId)).map((d) => d.title),
    ).not.toContain("On gone task");
  });

  test("scoped agents read only organization-wide documents and their projects", async () => {
    const otherTask = await createTask(db, ctx, "OTH", { title: "Hidden" });
    const orgDoc = await createDocument(db, ctx, { title: "Scope org" });
    const inScope = await createDocument(db, ctx, {
      title: "Scope SPI",
      project: "SPI",
    });
    const outProject = await createDocument(db, ctx, {
      title: "Scope OTH",
      project: "OTH",
    });
    const outTask = await createDocument(db, ctx, {
      title: "Scope OTH task",
      task: otherTask.key,
    });

    const { invite } = await createAgentInvite(db, ctx, {
      projectKeys: ["SPI"],
    });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const agent = (): ActorContext => ({
      orgId: ctx.orgId,
      actorId: actor.id,
      role: "member",
      source: "api",
    });

    const titles = (await listDocuments(db, agent())).map((d) => d.title);
    expect(titles).toContain(orgDoc.title);
    expect(titles).toContain(inScope.title);
    expect(titles).not.toContain(outProject.title);
    expect(titles).not.toContain(outTask.title);
    await expect(
      listDocuments(db, agent(), { project: "OTH" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      listDocuments(db, agent(), { task: otherTask.key }),
    ).rejects.toMatchObject({ code: "not_found" });

    for (const hidden of [outProject, outTask]) {
      await expect(getDocument(db, agent(), hidden.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        listDocumentVersions(db, agent(), hidden.id),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        getDocumentVersion(db, agent(), hidden.id, 1),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    for (const visible of [orgDoc, inScope]) {
      expect((await getDocument(db, agent(), visible.id)).id).toBe(visible.id);
      expect(
        (await listDocumentVersions(db, agent(), visible.id)).map(
          (v) => v.version,
        ),
      ).toEqual([1]);
      expect(
        (await getDocumentVersion(db, agent(), visible.id, 1)).version,
      ).toBe(1);
    }

    // An unscoped agent reads everything.
    const free = await createAgent(db, ctx, { name: "Docs Free Bot" });
    const freeCtx: ActorContext = { ...agent(), actorId: free.actor.id };
    expect((await getDocument(db, freeCtx, outTask.id)).id).toBe(outTask.id);
  });

  test("moves keep id and versions; task documents leave their task; activity is recorded", async () => {
    const doc = await createDocument(db, ctx, { title: "Plan", project: "SPI" });
    await updateDocument(db, ctx, doc.id, { baseVersion: 1, content: "v2" });

    const moved = await moveDocument(db, ctx, doc.id, { project: "oth" });
    expect(moved).toMatchObject({ id: doc.id, projectKey: "OTH", taskKey: null, version: 2, content: "v2" });
    expect(await listDocumentVersions(db, ctx, doc.id)).toHaveLength(2);
    expect((await listDocuments(db, ctx, { project: "SPI" })).map((d) => d.id)).not.toContain(doc.id);
    expect((await listDocuments(db, ctx, { project: "OTH" })).map((d) => d.id)).toContain(doc.id);

    // Already there: nothing changes.
    await moveDocument(db, ctx, doc.id, { project: "OTH" });

    const orgWide = await moveDocument(db, ctx, doc.id, { project: null });
    expect(orgWide).toMatchObject({ id: doc.id, projectKey: null, taskKey: null, version: 2 });

    const entries = await db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.entityId, doc.id), eq(schema.activity.action, "document.moved")));
    expect(entries.map((e) => e.changes)).toEqual([
      { title: "Plan", project: ["SPI", "OTH"] },
      { title: "Plan", project: ["OTH", null] },
    ]);

    const onTask = await createDocument(db, ctx, { title: "Task doc", task: "SPI-1" });
    const detached = await moveDocument(db, ctx, onTask.id, { project: "SPI" });
    expect(detached).toMatchObject({ projectKey: "SPI", taskKey: null });
    await expect(moveDocument(db, ctx, doc.id, { project: "NOPE" })).rejects.toMatchObject({ code: "not_found" });
    await expect(moveDocument(db, { ...ctx, role: "guest" }, doc.id, { project: "SPI" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("scoped agents need access to both the source and the target", async () => {
    const [agent] = await db
      .insert(schema.actors)
      .values({ orgId: ctx.orgId, type: "agent", name: "Scoped", handle: `scoped-${Date.now()}` })
      .returning();
    if (!agent) throw new Error("no agent");
    const [spi] = await db.select().from(schema.projects).where(and(eq(schema.projects.orgId, ctx.orgId), eq(schema.projects.key, "SPI")));
    if (!spi) throw new Error("no project");
    await db.insert(schema.agentProjects).values({ agentId: agent.id, projectId: spi.id });
    const scoped: ActorContext = { ...ctx, actorId: agent.id, role: "member", source: "mcp" };

    const inOther = await createDocument(db, ctx, { title: "Hidden", project: "OTH" });
    const inSpi = await createDocument(db, ctx, { title: "Visible", project: "SPI" });
    await expect(moveDocument(db, scoped, inOther.id, { project: "SPI" })).rejects.toMatchObject({ code: "not_found" });
    await expect(moveDocument(db, scoped, inSpi.id, { project: "OTH" })).rejects.toMatchObject({ code: "not_found" });
    expect(await moveDocument(db, scoped, inSpi.id, { project: null })).toMatchObject({ projectKey: null });
  });

  test("a scoped agent with no projects left fails closed when moving", async () => {
    const [agent] = await db
      .insert(schema.actors)
      .values({ orgId: ctx.orgId, type: "agent", name: "Emptied", handle: `emptied-${Date.now()}` })
      .returning();
    if (!agent) throw new Error("no agent");
    await db.insert(schema.agents).values({ actorId: agent.id, ownerId: ctx.actorId, scoped: true });
    const scoped: ActorContext = { ...ctx, actorId: agent.id, role: "member", source: "mcp" };

    const orgWide = await createDocument(db, ctx, { title: "Shared" });
    await expect(moveDocument(db, scoped, orgWide.id, { project: "SPI" })).rejects.toMatchObject({ code: "not_found" });
    expect(await moveDocument(db, scoped, orgWide.id, { project: null })).toMatchObject({
      id: orgWide.id,
      projectKey: null,
      taskKey: null,
      version: 1,
    });
    const moves = await db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.entityId, orgWide.id), eq(schema.activity.action, "document.moved")));
    expect(moves).toHaveLength(0);
  });

  test("documents can't be created or moved into an archived project, but can leave one", async () => {
    await createProject(db, ctx, { name: "Old", key: "OLD" });
    const inOld = await createDocument(db, ctx, { title: "Legacy", project: "OLD" });
    const free = await createDocument(db, ctx, { title: "Free" });
    await archiveProject(db, ctx, "OLD", true);
    await expect(createDocument(db, ctx, { title: "New", project: "OLD" })).rejects.toMatchObject({
      code: "validation",
      message: "Project OLD is archived",
    });
    await expect(moveDocument(db, ctx, free.id, { project: "OLD" })).rejects.toMatchObject({
      code: "validation",
      message: "Project OLD is archived",
    });
    expect(await moveDocument(db, ctx, inOld.id, { project: "SPI" })).toMatchObject({ projectKey: "SPI" });
  });
});
