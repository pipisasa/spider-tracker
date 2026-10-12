import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { acceptAgentInvite, createAgentInvite } from "./agent-invites";
import { createDocument, deleteDocument, getDocumentGraph, listBacklinks, updateDocument } from "./documents";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createTask, deleteTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("document links, backlinks and the graph (ST-100)", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `doc-links-${Date.now()}`;
  let ctx: ActorContext;
  let home = "";

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Links Org", slug });
    ctx = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    await createProject(db, ctx, { name: "Web", key: "WEB" });
    await createProject(db, ctx, { name: "Ops", key: "OPS" });
    await createTask(db, ctx, "WEB", { title: "Login" }); // WEB-1
    await createTask(db, ctx, "OPS", { title: "Deploy" }); // OPS-1
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  const linksOf = async (documentId: string) =>
    (await db.select().from(schema.documentLinks).where(eq(schema.documentLinks.documentId, documentId)))
      .map((r) => `${r.kind}:${r.target}`)
      .sort();

  test("saves rewrite a document's links; other edits keep them", async () => {
    const doc = await createDocument(db, ctx, {
      title: "Index",
      content: "[[Guide]] [[web-01|login]] and OPS-1, not `WEB-9`",
    });
    expect(await linksOf(doc.id)).toEqual(["document:Guide", "task:OPS-1", "task:WEB-1"]);
    const renamed = await updateDocument(db, ctx, doc.id, { baseVersion: 1, title: "Home" });
    expect(await linksOf(renamed.id)).toEqual(["document:Guide", "task:OPS-1", "task:WEB-1"]);
    await updateDocument(db, ctx, doc.id, { baseVersion: 2, content: "[[ Guide ]] only" });
    expect(await linksOf(doc.id)).toEqual(["document:Guide"]);
    home = doc.id;
  });

  test("the graph resolves titles, keeps unresolved ones and drops unknown tasks", async () => {
    const guide = await createDocument(db, ctx, { title: "Guide", project: "WEB" });
    const opsGuide = await createDocument(db, ctx, { title: "guide", project: "OPS" });
    const onTask = await createDocument(db, ctx, {
      task: "WEB-1",
      title: "Login notes",
      content: "[[Guide]] [[Missing page]] WEB-1 ZZZ-4 [[Login notes]]",
    });
    const fromOps = await createDocument(db, ctx, { project: "OPS", title: "Runbook", content: "[[GUIDE]] [[OPS-1]]" });

    const graph = await getDocumentGraph(db, ctx);
    const from = (id: string) => graph.links.filter((l) => l.from === id).map((l) => l.to);
    // Same-project titles win; self links and the document's own task are left out.
    expect(from(onTask.id)).toEqual([
      { type: "document", id: guide.id },
      { type: "unresolved", title: "Missing page" },
    ]);
    expect(from(fromOps.id)).toEqual([
      { type: "document", id: opsGuide.id },
      { type: "task", key: "OPS-1" },
    ]);
    expect(graph.tasks).toEqual([
      { key: "OPS-1", title: "Deploy", projectKey: "OPS", statusCategory: "todo" },
      { key: "WEB-1", title: "Login", projectKey: "WEB", statusCategory: "todo" },
    ]);
    expect(graph.projects).toEqual([
      { key: "WEB", name: "Web" },
      { key: "OPS", name: "Ops" },
    ]);

    // Backlinks list only the documents whose link opens this one.
    expect((await listBacklinks(db, ctx, guide.id)).map((d) => d.id)).toEqual([onTask.id]);
    // An organization-wide document has no project to prefer: the newest "guide" wins.
    expect((await listBacklinks(db, ctx, opsGuide.id)).map((d) => d.id)).toEqual([fromOps.id, home]);

    // Deleted documents and tasks leave the graph.
    await deleteDocument(db, ctx, fromOps.id);
    await deleteTask(db, ctx, "OPS-1");
    const after = await getDocumentGraph(db, ctx);
    expect(after.documents.map((d) => d.id)).not.toContain(fromOps.id);
    expect(after.tasks.map((t) => t.key)).toEqual(["WEB-1"]);
    expect((await listBacklinks(db, ctx, opsGuide.id)).map((d) => d.id)).toEqual([home]);
  });

  test("scoped agents see only their projects in the graph and backlinks", async () => {
    const shared = await createDocument(db, ctx, { title: "Shared" });
    const hidden = await createDocument(db, ctx, { project: "OPS", title: "Secret", content: "[[Shared]] WEB-1" });
    const visible = await createDocument(db, ctx, { project: "WEB", title: "Public", content: "[[Shared]] [[Secret]]" });

    const { invite } = await createAgentInvite(db, ctx, { projectKeys: ["WEB"] });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const agent: ActorContext = { orgId: ctx.orgId, actorId: actor.id, role: "member", source: "api" };

    const graph = await getDocumentGraph(db, agent);
    expect(graph.documents.map((d) => d.id)).not.toContain(hidden.id);
    expect(graph.projects.map((p) => p.key)).toEqual(["WEB"]);
    expect(graph.links.some((l) => l.from === hidden.id)).toBe(false);
    // A hidden document's title reads as unresolved, as if it didn't exist.
    expect(graph.links.filter((l) => l.from === visible.id).map((l) => l.to)).toEqual([
      { type: "unresolved", title: "Secret" },
      { type: "document", id: shared.id },
    ]);
    expect((await listBacklinks(db, agent, shared.id)).map((d) => d.id)).toEqual([visible.id]);
    await expect(listBacklinks(db, agent, hidden.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
