import { describe, expect, test } from "bun:test";
import { applyDocumentEdits, markdownHeadings } from "./document-edits";

const plan = [
  "# Plan",
  "",
  "Intro.",
  "",
  "## Решения",
  "",
  "Old decision.",
  "",
  "### Details",
  "",
  "Nested.",
  "",
  "## Next",
  "",
  "Later.",
  "",
].join("\n");

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected an error");
};

describe("applyDocumentEdits: fragments", () => {
  test("replaces a unique fragment", () => {
    expect(applyDocumentEdits("one two three", "md", [{ old: "two", new: "2" }])).toBe("one 2 three");
  });

  test("keeps $ patterns literal", () => {
    expect(applyDocumentEdits("price: X", "md", [{ old: "X", new: "$& $1 $$" }])).toBe("price: $& $1 $$");
  });

  test("a missing fragment is a conflict", () => {
    expect(errorOf(() => applyDocumentEdits("one two", "md", [{ old: "zero", new: "0" }]))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining(`doesn't contain "zero"`),
    });
  });

  test("an ambiguous fragment is a validation error unless all is set", () => {
    expect(errorOf(() => applyDocumentEdits("a b a", "md", [{ old: "a", new: "c" }]))).toMatchObject({
      code: "validation",
      message: expect.stringContaining("occurs 2 times"),
    });
    expect(applyDocumentEdits("a b a", "md", [{ old: "a", new: "c", all: true }])).toBe("c b c");
  });

  test("an empty fragment is invalid", () => {
    expect(errorOf(() => applyDocumentEdits("a", "md", [{ old: "", new: "b" }]))).toMatchObject({ code: "validation" });
  });
});

describe("applyDocumentEdits: append", () => {
  test("appends on a new line", () => {
    expect(applyDocumentEdits("", "md", [{ append: "a" }])).toBe("a");
    expect(applyDocumentEdits("a\n", "md", [{ append: "b" }])).toBe("a\nb");
    expect(applyDocumentEdits("a", "html", [{ append: "<p>b</p>" }])).toBe("a\n<p>b</p>");
  });

  test("empty text is invalid", () => {
    expect(errorOf(() => applyDocumentEdits("a", "md", [{ append: "" }]))).toMatchObject({ code: "validation" });
  });
});

describe("applyDocumentEdits: sections", () => {
  test("replaces the body up to the next heading of the same or a higher level", () => {
    const result = applyDocumentEdits(plan, "md", [{ section: "## Решения", content: "New decision.\n" }]);
    expect(result).toBe("# Plan\n\nIntro.\n\n## Решения\n\nNew decision.\n\n## Next\n\nLater.\n");
  });

  test("a sub-section ends at its next heading", () => {
    const result = applyDocumentEdits(plan, "md", [{ section: "### Details", content: "Fixed." }]);
    expect(result).toContain("### Details\n\nFixed.\n\n## Next");
    expect(result).toContain("Old decision.");
  });

  test("the last section runs to the end; an empty body clears it", () => {
    expect(applyDocumentEdits(plan, "md", [{ section: "## Next", content: "Soon." }])).toEndWith("## Next\n\nSoon.\n");
    expect(applyDocumentEdits(plan, "md", [{ section: "## Next", content: "" }])).toEndWith("Nested.\n\n## Next\n");
    expect(applyDocumentEdits(plan, "md", [{ section: "### Details", content: "" }])).toContain("### Details\n\n## Next");
  });

  test("a body starting with the same heading doesn't repeat it", () => {
    const result = applyDocumentEdits(plan, "md", [{ section: "## Next", content: "## Next\n\nSoon.\n" }]);
    expect(result).toEndWith("Nested.\n\n## Next\n\nSoon.\n");
  });

  test("matches a heading of any level by text alone, ignoring closing #s and extra spaces", () => {
    expect(applyDocumentEdits("# A\n\n##  Next  ##\nold\n", "md", [{ section: "Next", content: "new" }])).toBe(
      "# A\n\n##  Next  ##\n\nnew\n",
    );
  });

  test("a missing section is a conflict; a heading inside code doesn't count", () => {
    const text = "# A\n\n```md\n## Hidden\n```\n";
    expect(markdownHeadings(text).map((h) => h.text)).toEqual(["A"]);
    expect(errorOf(() => applyDocumentEdits(text, "md", [{ section: "## Hidden", content: "x" }]))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining('no section "## Hidden"'),
    });
  });

  test("an ambiguous section or an HTML document is a validation error", () => {
    expect(
      errorOf(() => applyDocumentEdits("## A\n1\n## A\n2\n", "md", [{ section: "## A", content: "x" }])),
    ).toMatchObject({ code: "validation", message: expect.stringContaining("2 sections") });
    expect(errorOf(() => applyDocumentEdits("<h2>A</h2>", "html", [{ section: "## A", content: "x" }]))).toMatchObject({
      code: "validation",
    });
  });
});

describe("applyDocumentEdits: several edits", () => {
  test("apply in order", () => {
    expect(applyDocumentEdits("a", "md", [{ append: "b" }, { old: "b", new: "c" }])).toBe("a\nc");
  });

  test("name the failing edit", () => {
    expect(errorOf(() => applyDocumentEdits("a", "md", [{ append: "b" }, { old: "z", new: "c" }]))).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/^Edit 2: /),
    });
  });
});
