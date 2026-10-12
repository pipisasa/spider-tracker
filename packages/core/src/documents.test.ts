import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { acceptAgentInvite, createAgentInvite } from "./agent-invites";
import { createAgent } from "./agents";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentVersion,
  listDocuments,
  listDocumentVersions,
  updateDocument,
} from "./documents";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
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
});
