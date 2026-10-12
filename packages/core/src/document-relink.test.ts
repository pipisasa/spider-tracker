import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { acceptAgentInvite, createAgentInvite } from "./agent-invites";
import {
  createDocument,
  getDocument,
  listDocumentVersions,
  listTaskBacklinks,
  updateDocument,
} from "./documents";
import { createOrganization } from "./organizations";
import { createProject, updateProject } from "./projects";
import { createTask, deleteTask } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("renames rewrite [[links]]; task backlinks (ST-101)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const memberUserId = `test-${crypto.randomUUID()}`;
  const slug = `doc-relink-${Date.now()}`;
  let owner: ActorContext;
  let member: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values([
      { id: userId, name: "Owner", email: `${userId}@example.com` },
      { id: memberUserId, name: "Member", email: `${memberUserId}@example.com` },
    ]);
    const { organization, actor } = await createOrganization(
      db,
      { id: userId, name: "Owner", email: "owner@example.com" },
      { name: "Relink Org", slug },
    );
    owner = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
    const [person] = await db
      .insert(schema.actors)
      .values({ orgId: owner.orgId, type: "human", userId: memberUserId, name: "Member", handle: "member", role: "member" })
      .returning();
    member = { orgId: owner.orgId, actorId: person?.id ?? "", role: "member", source: "ui" };
    await createProject(db, owner, { name: "Web", key: "WEB" });
    await createProject(db, owner, { name: "Ops", key: "OPS" });
    await createTask(db, owner, "WEB", { title: "Login" }); // WEB-1
    await createTask(db, owner, "WEB", { title: "Signup" }); // WEB-2
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const id of [userId, memberUserId]) await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("a rename rewrites the links that opened the document, as new versions by the renamer", async () => {
    const spec = await createDocument(db, owner, { project: "WEB", title: "Spec" });
    const opsSpec = await createDocument(db, owner, { project: "OPS", title: "spec" });
    const linking = await createDocument(db, owner, {
      project: "WEB",
      title: "Index",
      content: "See [[Spec]], [[ spec #Goals|the goals]] and `[[Spec]]`; [[Specs]] stays.",
    });
    // In OPS, [[Spec]] opens OPS's own "spec": not this one's link.
    const fromOps = await createDocument(db, owner, { project: "OPS", title: "Runbook", content: "[[Spec]]" });

    const renamed = await updateDocument(db, member, spec.id, { baseVersion: 1, title: "Design" });
    expect(renamed.relinked).toEqual({ rewritten: [{ id: linking.id, title: "Index" }], skipped: [] });

    const after = await getDocument(db, owner, linking.id);
    expect(after.content).toBe("See [[Design]], [[Design#Goals|the goals]] and `[[Spec]]`; [[Specs]] stays.");
    expect(after.version).toBe(2);
    expect(after.authorId).toBe(member.actorId);
    expect((await getDocument(db, owner, fromOps.id)).content).toBe("[[Spec]]");
    expect((await getDocument(db, owner, opsSpec.id)).version).toBe(1);
    expect((await listDocumentVersions(db, owner, linking.id))[0]?.authorId).toBe(member.actorId);

    // A change of case or spacing only needs no rewrite.
    const cased = await updateDocument(db, owner, spec.id, { baseVersion: renamed.version, title: "design" });
    expect(cased.relinked).toEqual({ rewritten: [], skipped: [] });
    // Saves that keep the title say nothing about links.
    const edited = await updateDocument(db, owner, spec.id, { baseVersion: cased.version, content: "x" });
    expect(edited.relinked).toBeUndefined();
  });

  test("a title that can't be linked to, or that another document has, becomes [[doc:<id>]]", async () => {
    const target = await createDocument(db, owner, { project: "WEB", title: "Plan" });
    await createDocument(db, owner, { project: "OPS", title: "Roadmap" });
    const linking = await createDocument(db, owner, { project: "WEB", title: "Notes", content: "[[Plan|the plan]] [[plan]]" });

    // [[Roadmap]] could open the other "Roadmap" (now, or after its next save).
    const first = await updateDocument(db, owner, target.id, { baseVersion: 1, title: "Roadmap" });
    expect(first.relinked?.rewritten).toEqual([{ id: linking.id, title: "Notes" }]);
    expect((await getDocument(db, owner, linking.id)).content).toBe(
      `[[doc:${target.id}|the plan]] [[doc:${target.id}]]`,
    );

    const other = await createDocument(db, owner, { project: "WEB", title: "Other", content: "[[Roadmap 2]]" });
    const second = await createDocument(db, owner, { project: "WEB", title: "Roadmap 2" });
    await updateDocument(db, owner, second.id, { baseVersion: 1, title: "Q3 | Q4" });
    expect((await getDocument(db, owner, other.id)).content).toBe(`[[doc:${second.id}]]`);
  });

  test("the rewrite never goes past the renamer's rights", async () => {
    const target = await createDocument(db, owner, { title: "Glossary" });
    const rules = await createDocument(db, owner, { project: "WEB", title: "Rules", content: "Read [[Glossary]]." });
    await updateProject(db, owner, "WEB", { rulesDocumentId: rules.id });
    const hidden = await createDocument(db, owner, { project: "OPS", title: "Ops notes", content: "[[Glossary]]" });
    const open = await createDocument(db, owner, { project: "WEB", title: "Web notes", content: "[[Glossary]]" });

    // An agent scoped to WEB: OPS is out of sight and stays as written.
    const { invite } = await createAgentInvite(db, member, { projectKeys: ["WEB"] });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const agent: ActorContext = { orgId: owner.orgId, actorId: actor.id, role: "member", source: "mcp" };

    const renamed = await updateDocument(db, agent, target.id, { baseVersion: 1, title: "Terms" });
    expect(renamed.relinked).toEqual({
      rewritten: [{ id: open.id, title: "Web notes" }],
      skipped: [{ id: rules.id, title: "Rules", reason: "rules" }],
    });
    expect((await getDocument(db, owner, open.id)).content).toBe("[[Terms]]");
    expect((await getDocument(db, owner, rules.id)).content).toBe("Read [[Glossary]].");
    expect((await getDocument(db, owner, hidden.id)).content).toBe("[[Glossary]]");

    // Renamed back, every link opens it again; the owner may change rules, so all are rewritten.
    const back = await updateDocument(db, owner, target.id, { baseVersion: renamed.version, title: "Glossary" });
    expect(back.relinked?.rewritten).toEqual([{ id: open.id, title: "Web notes" }]);
    const words = await updateDocument(db, owner, target.id, { baseVersion: back.version, title: "Words" });
    expect(words.relinked?.rewritten.map((d) => d.id).sort()).toEqual([rules.id, hidden.id, open.id].sort());
    expect(words.relinked?.skipped).toEqual([]);
    expect((await getDocument(db, owner, rules.id)).content).toBe("Read [[Words]].");
  });

  test("task backlinks list the documents mentioning a task, not its own", async () => {
    const wiki = await createDocument(db, owner, { project: "OPS", title: "Wiki ref", content: "[[web-1|login]]" });
    const plain = await createDocument(db, owner, { title: "Plain ref", content: "Fixed in WEB-1. Not `WEB-1` code." });
    await createDocument(db, owner, { task: "WEB-1", title: "Own doc", content: "WEB-1 notes" });
    await createDocument(db, owner, { title: "Code only", content: "`WEB-2`" });

    expect((await listTaskBacklinks(db, owner, "web-1")).map((d) => d.id)).toEqual([plain.id, wiki.id]);
    expect(await listTaskBacklinks(db, owner, "WEB-2")).toEqual([]);

    const { invite } = await createAgentInvite(db, owner, { projectKeys: ["WEB"] });
    const { actor } = await acceptAgentInvite(db, { code: invite.code });
    const agent: ActorContext = { orgId: owner.orgId, actorId: actor.id, role: "member", source: "api" };
    expect((await listTaskBacklinks(db, agent, "WEB-1")).map((d) => d.id)).toEqual([plain.id]);

    await deleteTask(db, owner, "WEB-2");
    await expect(listTaskBacklinks(db, owner, "WEB-2")).rejects.toMatchObject({ code: "not_found" });
  });
});
