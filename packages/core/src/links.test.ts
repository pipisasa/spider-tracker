import { describe, expect, test } from "bun:test";
import {
  documentIdLink,
  documentIdTarget,
  isLinkableTitle,
  normalizeTitle,
  outgoingLinksIn,
  resolveDocumentLink,
  resolveTitle,
  retargetTitleLinks,
  taskKeyTarget,
  wikiLinksIn,
} from "./links";

describe("wikiLinksIn", () => {
  test("reads targets, labels and heading parts", () => {
    expect(
      wikiLinksIn("See [[Plan]], [[Plan v2|the plan]] and [[Spec#Goals]]."),
    ).toEqual([
      { target: "Plan", label: null },
      { target: "Plan v2", label: "the plan" },
      { target: "Spec", label: null },
    ]);
  });

  test("skips empty, broken and code links", () => {
    const text =
      "[[ ]] [[a\nb]] [single] `[[Inline]]`\n\n```md\n[[Fenced]]\n```\n<code>[[Html]]</code> [[Real]]";
    expect(wikiLinksIn(text).map((l) => l.target)).toEqual(["Real"]);
  });

  test("an unclosed fence hides the rest", () => {
    expect(wikiLinksIn("[[A]]\n```\n[[B]]")).toEqual([
      { target: "A", label: null },
    ]);
  });
  test("a 4-backtick fence holding 3-backtick lines ends at a line at least as long (ST-134)", () => {
    const text =
      "````md\n```\n[[Inside]]\n```\n[[Still]]\n`````\n[[After]]\n~~~\n[[Tilde]]\n```\n[[Open]]\n~~~~\n[[Last]]";
    expect(wikiLinksIn(text).map((l) => l.target)).toEqual(["After", "Last"]);
  });

  test("a fence indented up to 3 spaces, as in a list item, is code (ST-134)", () => {
    const text =
      "- step:\n  ```sh\n  [[Listed]]\n  ```\n- [[Item]]\n    ```\n[[Indented]]";
    expect(wikiLinksIn(text).map((l) => l.target)).toEqual([
      "Item",
      "Indented",
    ]);
  });

  test("code spans pair equal backtick runs, never across a blank line (ST-134)", () => {
    const text =
      "A stray ` here\n\n[[One]] and ``[[Two]]`` then ```[[Three]]`` [[Four]] ` x\n\n[[Five]]";
    expect(wikiLinksIn(text).map((l) => l.target)).toEqual([
      "One",
      "Three",
      "Four",
      "Five",
    ]);
  });
});

describe("outgoingLinksIn", () => {
  test("splits documents from tasks and drops repeats", () => {
    expect(
      outgoingLinksIn(
        "[[Roadmap]] [[roadmap ]] [[st-12]] mentions ST-12 and OPS-3; [[ST-1 notes]]",
      ),
    ).toEqual({
      documents: ["Roadmap", "ST-1 notes"],
      documentIds: [],
      tasks: ["ST-12", "OPS-3"],
    });
  });

  test("ignores task keys in code", () => {
    expect(outgoingLinksIn("`ST-4` and\n```\nST-5\n```")).toEqual({
      documents: [],
      documentIds: [],
      tasks: [],
    });
  });
});

test("normalizeTitle and taskKeyTarget", () => {
  expect(normalizeTitle("  Release   Plan ")).toBe("release plan");
  expect(taskKeyTarget("st-007")).toBe("ST-7");
  expect(taskKeyTarget("Plan")).toBeNull();
});

describe("resolveTitle", () => {
  const docs = [
    { id: "ops", title: "Notes", projectKey: "OPS", updatedAt: "2026-10-03" },
    { id: "org", title: "notes", projectKey: null, updatedAt: "2026-10-01" },
    { id: "st-old", title: "Notes", projectKey: "ST", updatedAt: "2026-10-01" },
    {
      id: "st-new",
      title: "Notes ",
      projectKey: "ST",
      updatedAt: "2026-10-02",
    },
  ];

  test("prefers the same project, then the organization, then the newest", () => {
    expect(resolveTitle(docs, "notes", "ST")?.id).toBe("st-new");
    expect(resolveTitle(docs, "Notes", "WEB")?.id).toBe("org");
    expect(resolveTitle(docs, "Notes", null)?.id).toBe("org");
    expect(resolveTitle(docs.slice(2), "Notes", "WEB")?.id).toBe("st-new");
    expect(resolveTitle(docs, "Missing", "ST")).toBeNull();
  });
});

const ID = "01a13118-982f-7c2e-8a6e-932d744cc798";

describe("links by id (ST-115)", () => {
  test("documentIdTarget reads doc:<uuid> in any case; documentIdLink writes it", () => {
    expect(documentIdTarget(`doc:${ID}`)).toBe(ID);
    expect(documentIdTarget(` DOC: ${ID.toUpperCase()} `)).toBe(ID);
    expect(documentIdTarget("doc:not-an-id")).toBeNull();
    expect(documentIdTarget(ID)).toBeNull();
    expect(documentIdLink(ID.toUpperCase())).toBe(`doc:${ID}`);
  });

  test("outgoingLinksIn lists ids apart from titles, once each", () => {
    expect(
      outgoingLinksIn(
        `[[doc:${ID}|Spec]] [[doc:${ID.toUpperCase()}#Goals]] [[doc:x]]`,
      ),
    ).toEqual({
      documents: ["doc:x"],
      documentIds: [ID],
      tasks: [],
    });
  });

  test("resolveDocumentLink opens ids and titles", () => {
    const docs = [
      { id: ID, title: "Spec", projectKey: "ST", updatedAt: "2026-10-01" },
      { id: "other", title: "Plan", projectKey: null, updatedAt: "2026-10-01" },
    ];
    expect(resolveDocumentLink(docs, `doc:${ID}`, null)?.title).toBe("Spec");
    expect(resolveDocumentLink(docs, "plan", "ST")?.id).toBe("other");
    expect(
      resolveDocumentLink(
        docs,
        "doc:00000000-0000-7000-8000-000000000000",
        null,
      ),
    ).toBeNull();
  });
});

describe("retargetTitleLinks (ST-101)", () => {
  test("rewrites the title in any case or spacing, keeping headings and labels", () => {
    const text =
      "[[Old]] [[ old  #Intro]] [[OLD|label]] [[Old#A|b]] [[Older]] [[doc:x]]";
    expect(retargetTitleLinks(text, "Old", "New")).toBe(
      "[[New]] [[New#Intro]] [[New|label]] [[New#A|b]] [[Older]] [[doc:x]]",
    );
  });

  test("leaves code alone and returns the same text without matches", () => {
    const text = "`[[Old]]`\n```\n[[Old]]\n```\n<code>[[Old]]</code> [[Old]]";
    expect(retargetTitleLinks(text, "Old", "doc:1")).toBe(
      "`[[Old]]`\n```\n[[Old]]\n```\n<code>[[Old]]</code> [[doc:1]]",
    );
    expect(retargetTitleLinks("[[Other]]", "Old", "New")).toBe("[[Other]]");
  });
});

describe("isLinkableTitle", () => {
  test("rejects titles a [[link]] can't name", () => {
    expect(["Plan", "Plan v2 (draft)"].map(isLinkableTitle)).toEqual([
      true,
      true,
    ]);
    expect(
      [
        "",
        "  ",
        "A | B",
        "C#",
        "[x]",
        "ST-12",
        "doc:01a1217e-7dd6-7d02-9d7c-45929504ed9f",
      ].map(isLinkableTitle),
    ).toEqual(Array(7).fill(false));
  });
});
