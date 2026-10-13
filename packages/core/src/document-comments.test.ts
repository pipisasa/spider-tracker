import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import {
  documentSkeleton,
  quoteOccursIn,
  quoteOccursInSkeleton,
  skeleton,
  skeletonIndex,
} from "./anchors";
import { AGENT_COMMENT_LIMIT } from "./comments";
import {
  addDocumentComment,
  listDocumentComments,
  resolveDocumentComment,
} from "./document-comments";
import { createDocument, deleteDocument, editDocument } from "./documents";
import { listInbox, markInboxRead } from "./inbox";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { INBOX_KINDS } from "./schemas";
import { createTask, deleteTask } from "./tasks";

describe("quoteOccursIn", () => {
  test("matches the text a reader sees, ignoring markup, link targets, punctuation and whitespace", () => {
    const md =
      "We ship **the new** plan in [Q3](https://example.com/q3), see [[Roadmap|the roadmap]].\n\nNext  line";
    expect(quoteOccursIn(md, "md", "the new plan in Q3")).toBe(true);
    expect(quoteOccursIn(md, "md", "see the roadmap")).toBe(true);
    expect(quoteOccursIn(md, "md", "Q3, see the roadmap. Next line")).toBe(
      true,
    );
    expect(quoteOccursIn(md, "md", "example.com")).toBe(false);
    expect(quoteOccursIn(md, "md", "the old plan")).toBe(false);
  });

  test("HTML: tags and entities don't count", () => {
    const html =
      "<p>Ready <b>by</b>&nbsp;Friday &amp; done</p><style>.x{}</style>";
    expect(quoteOccursIn(html, "html", "Ready by Friday & done")).toBe(true);
    expect(quoteOccursIn(html, "html", "x")).toBe(false);
  });

  test("skeletonIndex maps each skeleton character back to the text", () => {
    const text = "Ship **it**, Today";
    const { skeleton: sk, offsets } = skeletonIndex(text);
    expect(sk).toBe(skeleton(text));
    expect(sk).toBe("shipittoday");
    const at = sk.indexOf("ittoday");
    expect(
      text.slice(offsets[at], (offsets[at + "ittoday".length - 1] ?? 0) + 1),
    ).toBe("it**, Today");
  });

  test("Markdown entities read as the characters they show (ST-134)", () => {
    const md = "Caf&eacute; &amp; bar &copy; 2026&nbsp;Acme &#8212; &#x41;BC";
    expect(quoteOccursIn(md, "md", "Café & bar © 2026 Acme — ABC")).toBe(true);
    expect(quoteOccursIn(md, "md", "copy")).toBe(false);
    // A quote copied from the source, entities and all, matches too (ST-134).
    expect(quoteOccursIn(md, "md", "Caf&eacute; &amp; bar")).toBe(true);
    expect(quoteOccursIn(md, "md", "&copy; 2026&nbsp;Acme")).toBe(true);
  });

  test("code shows as written: no entity decoding or [[…]] titles inside it (ST-134)", () => {
    const id = "01a13118-ef01-7aa0-bf37-10e38fb20956";
    const label = (target: string) =>
      target === `doc:${id}` ? "Q3 Roadmap" : null;
    const md = `Use \`[[doc:${id}]] &copy;\` in [[doc:${id}]].\n\n\`\`\`\nx &amp; [[doc:${id}]]\n\`\`\`\n`;
    // In code, the raw text matches (as the web shows it); outside, the title does.
    expect(quoteOccursIn(md, "md", `[[doc:${id}]] &copy;`, label)).toBe(true);
    expect(quoteOccursIn(md, "md", `x &amp; [[doc:${id}]]`, label)).toBe(true);
    expect(quoteOccursIn(md, "md", "in Q3 Roadmap", label)).toBe(true);
    expect(quoteOccursIn(md, "md", "Use Q3 Roadmap", label)).toBe(false);
    expect(quoteOccursIn(md, "md", "x & Q3 Roadmap", label)).toBe(false);
  });

  test("a link whose label holds code shows its label, code and all (ST-134)", () => {
    const md = "See [`spider doc publish`](cli.md) writes files.\n";
    expect(quoteOccursIn(md, "md", "spider doc publish writes files")).toBe(
      true,
    );
    expect(quoteOccursIn(md, "md", "cli.md")).toBe(false);
    const wiki = "Read [[Title|`x &amp; y`]] next.";
    expect(quoteOccursIn(wiki, "md", "Read x &amp; y next")).toBe(true);
    expect(quoteOccursIn(wiki, "md", "Title")).toBe(false);
    // A quote typed in decoded form against code doesn't match: code shows as written.
    expect(quoteOccursIn(wiki, "md", "x & y")).toBe(false);
  });

  test("[[doc:<id>]] matches the title it shows; a labelled link its label (ST-134)", () => {
    const id = "01a13118-ef01-7aa0-bf37-10e38fb20956";
    const md = `See [[doc:${id}]] and [[doc:${id}#Dates|the dates]] now.`;
    const label = (target: string) =>
      target.split("#")[0] === `doc:${id}` ? "Q3 Roadmap" : null;
    expect(quoteOccursIn(md, "md", "See Q3 Roadmap and the dates", label)).toBe(
      true,
    );
    // Without a title (a document the reader can't see) the target shows, as in the web app.
    expect(quoteOccursIn(md, "md", "See Q3 Roadmap")).toBe(false);
    expect(quoteOccursIn(md, "md", `See doc:${id} and`)).toBe(true);
  });

  test("a document skeleton is built once for many quotes", () => {
    const doc = documentSkeleton("We ship **the API** first.", "md");
    expect(quoteOccursInSkeleton(doc, "the API first")).toBe(true);
    expect(quoteOccursInSkeleton(doc, "the UI")).toBe(false);
    expect(quoteOccursInSkeleton(doc, "**")).toBe(true);
  });

  test("a quote of only symbols is compared as written", () => {
    expect(quoteOccursIn("a -> b", "md", "->")).toBe(true);
    expect(quoteOccursIn("a => b", "md", "->")).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
const ALL_KINDS = { kinds: [...INBOX_KINDS] };

run("document comments", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `doc-comments-${Date.now()}`;
  let owner: ActorContext;
  let alpha: ActorContext;
  let beta: ActorContext;
  let scoped: ActorContext;
  let docId: string;

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: user.id,
      name: user.name,
      email: `${user.id}@example.com`,
    });
    const { organization, actor } = await createOrganization(db, user, {
      name: "Doc Comments Org",
      slug,
    });
    owner = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider", key: "SPI" });
    await createProject(db, owner, { name: "Other", key: "OTH" });
    const a = await createAgent(db, owner, { name: "Alpha" });
    const b = await createAgent(db, owner, { name: "Beta" });
    const s = await createAgent(db, owner, { name: "Scoped" });
    const [oth] = await db
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, organization.id),
          eq(schema.projects.key, "OTH"),
        ),
      );
    if (!oth) throw new Error("no project");
    await db
      .insert(schema.agentProjects)
      .values({ agentId: s.actor.id, projectId: oth.id });
    alpha = {
      orgId: organization.id,
      actorId: a.actor.id,
      role: "member",
      source: "mcp",
    };
    beta = {
      orgId: organization.id,
      actorId: b.actor.id,
      role: "member",
      source: "mcp",
    };
    scoped = {
      orgId: organization.id,
      actorId: s.actor.id,
      role: "member",
      source: "mcp",
    };
    docId = (
      await createDocument(db, owner, {
        title: "Spec",
        project: "SPI",
        content: "# Spec\n\nWe ship **the API** first.\n\nThen the UI.",
      })
    ).id;
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("a review is stored on the document; the author, mentions and the thread are notified", async () => {
    const review = await addDocumentComment(db, alpha, docId, {
      body: "Looks good, @beta please check the UI part",
    });
    expect(review).toMatchObject({
      documentId: docId,
      parentId: null,
      quote: null,
      outdated: false,
      documentVersion: 1,
      resolvedAt: null,
    });

    // The document's author gets a document_comment item; the mentioned agent a document_mention.
    const ownerInbox = await listInbox(db, owner, ALL_KINDS);
    expect(ownerInbox.map((i) => [i.kind, i.from.handle])).toEqual([
      ["document_comment", "alpha"],
    ]);
    expect(ownerInbox[0]).toMatchObject({
      task: null,
      document: { id: docId, title: "Spec", projectKey: "SPI" },
      comment: { id: review.id },
    });
    expect((await listInbox(db, beta, ALL_KINDS)).map((i) => i.kind)).toEqual([
      "document_mention",
    ]);
    // Clients that don't ask for document kinds (older CLIs expect a task) don't get them.
    expect(await listInbox(db, owner)).toEqual([]);

    // A reply notifies the author replied to and the rest of the thread, but not the replier.
    const reply = await addDocumentComment(db, beta, docId, {
      body: "Checked",
      parentId: review.id,
    });
    const nested = await addDocumentComment(db, owner, docId, {
      body: "Thanks both",
      parentId: reply.id,
    });
    expect((await listInbox(db, beta, ALL_KINDS)).map((i) => i.kind)).toEqual([
      "document_mention",
      "document_reply",
    ]);
    expect((await listInbox(db, alpha, ALL_KINDS)).map((i) => i.kind)).toEqual([
      "document_reply",
      "document_comment",
    ]);
    expect(nested.parentId).toBe(reply.id);

    const listed = await listDocumentComments(db, owner, docId);
    expect(listed.map((c) => c.body)).toEqual([
      "Looks good, @beta please check the UI part",
      "Checked",
      "Thanks both",
    ]);
  });

  test("a fragment comment quotes the text, and is outdated once the text changes", async () => {
    const anchored = await addDocumentComment(db, owner, docId, {
      body: "Why first?",
      quote: "the API first",
    });
    expect(anchored).toMatchObject({ quote: "the API first", outdated: false });

    await expect(
      addDocumentComment(db, owner, docId, {
        body: "?",
        quote: "not in the text",
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      addDocumentComment(db, owner, docId, {
        body: "?",
        quote: "the API",
        parentId: anchored.id,
      }),
    ).rejects.toMatchObject({
      code: "validation",
    });

    await editDocument(db, owner, docId, {
      edits: [{ old: "**the API** first", new: "the UI first" }],
    });
    const after = (await listDocumentComments(db, owner, docId)).find(
      (c) => c.id === anchored.id,
    );
    expect(after).toMatchObject({
      quote: "the API first",
      outdated: true,
      documentVersion: 1,
    });
  });

  test("threads are resolved and reopened; replies can't be", async () => {
    const root = await addDocumentComment(db, owner, docId, {
      body: "Resolve me",
    });
    const reply = await addDocumentComment(db, alpha, docId, {
      body: "Done",
      parentId: root.id,
    });
    const resolved = await resolveDocumentComment(db, alpha, docId, root.id, {
      resolved: true,
    });
    expect(resolved).toMatchObject({
      resolvedBy: alpha.actorId,
      resolvedAt: expect.any(String),
    });
    // A repeat changes nothing.
    expect(
      (
        await resolveDocumentComment(db, owner, docId, root.id, {
          resolved: true,
        })
      ).resolvedBy,
    ).toBe(alpha.actorId);
    await expect(
      resolveDocumentComment(db, owner, docId, reply.id, { resolved: true }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      resolveDocumentComment(db, owner, docId, crypto.randomUUID(), {
        resolved: true,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await resolveDocumentComment(db, owner, docId, root.id, {
        resolved: false,
      }),
    ).toMatchObject({ resolvedAt: null, resolvedBy: null });
  });

  test("a reply to a resolved thread reopens it (ST-134)", async () => {
    const root = await addDocumentComment(db, owner, docId, {
      body: "Is this settled?",
    });
    await resolveDocumentComment(db, owner, docId, root.id, { resolved: true });
    const reply = await addDocumentComment(db, alpha, docId, {
      body: "Not quite",
      parentId: root.id,
    });
    const thread = (await listDocumentComments(db, owner, docId)).filter(
      (c) => c.id === root.id || c.parentId === root.id,
    );
    expect(thread.find((c) => c.id === root.id)).toMatchObject({
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(thread.map((c) => c.id)).toContain(reply.id);
    const reopened = await db
      .select()
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.entityId, docId),
          eq(schema.activity.action, "comment.reopened"),
        ),
      );
    expect(reopened.map((a) => a.changes)).toContainEqual({
      commentId: root.id,
      replyId: reply.id,
    });
    // A reply to an open thread changes nothing.
    await addDocumentComment(db, owner, docId, {
      body: "Now it is",
      parentId: reply.id,
    });
    expect(
      (await listDocumentComments(db, owner, docId)).find(
        (c) => c.id === root.id,
      )?.resolvedAt,
    ).toBeNull();
  });

  test("a quote across a [[doc:<id>]] link matches the title it shows (ST-134)", async () => {
    const target = await createDocument(db, owner, {
      title: "Q3 Roadmap",
      project: "SPI",
    });
    const doc = await createDocument(db, owner, {
      title: "Linking",
      project: "SPI",
      content: `Dates are in [[doc:${target.id}]] &mdash; ask first.`,
    });
    const comment = await addDocumentComment(db, owner, doc.id, {
      body: "Which dates?",
      quote: "Dates are in Q3 Roadmap — ask",
    });
    expect(comment).toMatchObject({ outdated: false });
    expect((await listDocumentComments(db, owner, doc.id))[0]).toMatchObject({
      id: comment.id,
      outdated: false,
    });
    await expect(
      addDocumentComment(db, owner, doc.id, {
        body: "?",
        quote: "Dates are in Q4",
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("select a shorter part"),
    });
  });

  test("permissions and scope: guests can't write, scoped agents only see their projects' documents", async () => {
    const guest: ActorContext = { ...owner, role: "guest" };
    await expect(
      addDocumentComment(db, guest, docId, { body: "hi" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      resolveDocumentComment(db, guest, docId, crypto.randomUUID(), {
        resolved: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (await listDocumentComments(db, guest, docId)).length,
    ).toBeGreaterThan(0);

    await expect(listDocumentComments(db, scoped, docId)).rejects.toMatchObject(
      { code: "not_found" },
    );
    await expect(
      addDocumentComment(db, scoped, docId, { body: "hi" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      listDocumentComments(db, owner, "not-a-uuid"),
    ).rejects.toMatchObject({ code: "not_found" });

    // Organization-wide documents are open to scoped agents, and their inbox items reach them.
    const orgWide = await createDocument(db, scoped, { title: "Shared notes" });
    await addDocumentComment(db, owner, orgWide.id, { body: "Noted" });
    const items = await listInbox(db, scoped, ALL_KINDS);
    expect(items.at(-1)).toMatchObject({
      kind: "document_comment",
      document: { id: orgWide.id, projectKey: null },
    });
    // A mention on a document outside the agent's scope stays out of its inbox.
    const before = (await listInbox(db, scoped, ALL_KINDS)).length;
    await addDocumentComment(db, owner, docId, {
      body: "@scoped can you see this?",
    });
    expect((await listInbox(db, scoped, ALL_KINDS)).length).toBe(before);
  });

  test("deleted documents hide their comments and inbox items; agents are rate-limited", async () => {
    const doc = await createDocument(db, owner, {
      title: "Short-lived",
      project: "SPI",
    });
    for (let i = 0; i < AGENT_COMMENT_LIMIT.perMinute; i++)
      await addDocumentComment(db, beta, doc.id, { body: `note ${i}` });
    await expect(
      addDocumentComment(db, beta, doc.id, { body: "one too many" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // People aren't limited.
    await addDocumentComment(db, owner, doc.id, { body: "fine" });

    expect(
      (await listInbox(db, owner, ALL_KINDS)).some(
        (i) => i.document?.id === doc.id,
      ),
    ).toBe(true);
    await deleteDocument(db, owner, doc.id);
    await expect(listDocumentComments(db, owner, doc.id)).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(
      (await listInbox(db, owner, ALL_KINDS)).some(
        (i) => i.document?.id === doc.id,
      ),
    ).toBe(false);
  });

  test("a deleted task hides its documents' inbox items (ST-134)", async () => {
    const task = await createTask(db, owner, "SPI", { title: "Has a doc" });
    const doc = await createDocument(db, owner, {
      title: "Task doc",
      task: task.key,
    });
    await addDocumentComment(db, alpha, doc.id, { body: "On the task doc" });
    const has = async () =>
      (await listInbox(db, owner, ALL_KINDS)).some(
        (i) => i.document?.id === doc.id,
      );
    expect(await has()).toBe(true);
    await deleteTask(db, owner, task.key);
    expect(await has()).toBe(false);
  });

  test("marking read up to an id leaves document items alone unless their kinds are named (ST-128)", async () => {
    const unread = async () =>
      (await listInbox(db, beta, { ...ALL_KINDS, unread: true })).map(
        (i) => i.kind,
      );
    expect(await unread()).toEqual(["document_mention", "document_reply"]);
    // Clients from before ST-118 never fetch document items, so their `upTo` must not mark them.
    expect(
      await markInboxRead(db, beta, { upTo: Number.MAX_SAFE_INTEGER }),
    ).toBe(0);
    expect(await unread()).toEqual(["document_mention", "document_reply"]);
    expect(
      await markInboxRead(db, beta, {
        upTo: Number.MAX_SAFE_INTEGER,
        ...ALL_KINDS,
      }),
    ).toBe(2);
    expect(await unread()).toEqual([]);
  });
});
