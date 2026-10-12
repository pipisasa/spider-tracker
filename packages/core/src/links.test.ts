import { describe, expect, test } from "bun:test";
import { normalizeTitle, outgoingLinksIn, resolveTitle, taskKeyTarget, wikiLinksIn } from "./links";

describe("wikiLinksIn", () => {
  test("reads targets, labels and heading parts", () => {
    expect(wikiLinksIn("See [[Plan]], [[Plan v2|the plan]] and [[Spec#Goals]].")).toEqual([
      { target: "Plan", label: null },
      { target: "Plan v2", label: "the plan" },
      { target: "Spec", label: null },
    ]);
  });

  test("skips empty, broken and code links", () => {
    const text = "[[ ]] [[a\nb]] [single] `[[Inline]]`\n\n```md\n[[Fenced]]\n```\n<code>[[Html]]</code> [[Real]]";
    expect(wikiLinksIn(text).map((l) => l.target)).toEqual(["Real"]);
  });

  test("an unclosed fence hides the rest", () => {
    expect(wikiLinksIn("[[A]]\n```\n[[B]]")).toEqual([{ target: "A", label: null }]);
  });
});

describe("outgoingLinksIn", () => {
  test("splits documents from tasks and drops repeats", () => {
    expect(outgoingLinksIn("[[Roadmap]] [[roadmap ]] [[st-12]] mentions ST-12 and OPS-3; [[ST-1 notes]]")).toEqual({
      documents: ["Roadmap", "ST-1 notes"],
      tasks: ["ST-12", "OPS-3"],
    });
  });

  test("ignores task keys in code", () => {
    expect(outgoingLinksIn("`ST-4` and\n```\nST-5\n```")).toEqual({ documents: [], tasks: [] });
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
    { id: "st-new", title: "Notes ", projectKey: "ST", updatedAt: "2026-10-02" },
  ];

  test("prefers the same project, then the organization, then the newest", () => {
    expect(resolveTitle(docs, "notes", "ST")?.id).toBe("st-new");
    expect(resolveTitle(docs, "Notes", "WEB")?.id).toBe("org");
    expect(resolveTitle(docs, "Notes", null)?.id).toBe("org");
    expect(resolveTitle(docs.slice(2), "Notes", "WEB")?.id).toBe("st-new");
    expect(resolveTitle(docs, "Missing", "ST")).toBeNull();
  });
});
