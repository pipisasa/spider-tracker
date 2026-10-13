import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { quoteOccursIn, skeleton, skeletonIndex } from "./anchors";
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
