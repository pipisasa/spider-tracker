import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { applyDocumentEdits, markdownHeadings } from "./document-edits";
import {
  createDocumentInput,
  documentEditSchema,
  MAX_DOCUMENT_BYTES,
} from "./schemas";

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
    expect(
      applyDocumentEdits("one two three", "md", [{ old: "two", new: "2" }]),
    ).toBe("one 2 three");
  });

  test("keeps $ patterns literal", () => {
    expect(
      applyDocumentEdits("price: X", "md", [{ old: "X", new: "$& $1 $$" }]),
    ).toBe("price: $& $1 $$");
  });

  test("a missing fragment is a conflict", () => {
    expect(
      errorOf(() =>
        applyDocumentEdits("one two", "md", [{ old: "zero", new: "0" }]),
      ),
    ).toMatchObject({
      code: "conflict",
      message: expect.stringContaining(`doesn't contain "zero"`),
    });
  });

  test("an ambiguous fragment is a validation error unless all is set", () => {
    expect(
      errorOf(() =>
        applyDocumentEdits("a b a", "md", [{ old: "a", new: "c" }]),
      ),
    ).toMatchObject({
      code: "validation",
      message: expect.stringContaining("occurs 2 times"),
    });
    expect(
      applyDocumentEdits("a b a", "md", [{ old: "a", new: "c", all: true }]),
    ).toBe("c b c");
  });

  test("an empty fragment is invalid", () => {
    expect(
      errorOf(() => applyDocumentEdits("a", "md", [{ old: "", new: "b" }])),
    ).toMatchObject({ code: "validation" });
  });
});

describe("applyDocumentEdits: append", () => {
  test("appends on a new line", () => {
    expect(applyDocumentEdits("", "md", [{ append: "a" }])).toBe("a");
    expect(applyDocumentEdits("a\n", "md", [{ append: "b" }])).toBe("a\nb");
    expect(applyDocumentEdits("a", "html", [{ append: "<p>b</p>" }])).toBe(
      "a\n<p>b</p>",
    );
  });

  test("empty text is invalid", () => {
    expect(
      errorOf(() => applyDocumentEdits("a", "md", [{ append: "" }])),
    ).toMatchObject({ code: "validation" });
  });
});

describe("applyDocumentEdits: sections", () => {
  test("replaces the body up to the next heading of the same or a higher level", () => {
    const result = applyDocumentEdits(plan, "md", [
      { section: "## Решения", content: "New decision.\n" },
    ]);
    expect(result).toBe(
      "# Plan\n\nIntro.\n\n## Решения\n\nNew decision.\n\n## Next\n\nLater.\n",
    );
  });

  test("a sub-section ends at its next heading", () => {
    const result = applyDocumentEdits(plan, "md", [
      { section: "### Details", content: "Fixed." },
    ]);
    expect(result).toContain("### Details\n\nFixed.\n\n## Next");
    expect(result).toContain("Old decision.");
  });

  test("the last section runs to the end; an empty body clears it", () => {
    expect(
      applyDocumentEdits(plan, "md", [
        { section: "## Next", content: "Soon." },
      ]),
    ).toEndWith("## Next\n\nSoon.\n");
    expect(
      applyDocumentEdits(plan, "md", [{ section: "## Next", content: "" }]),
    ).toEndWith("Nested.\n\n## Next\n");
    expect(
      applyDocumentEdits(plan, "md", [{ section: "### Details", content: "" }]),
    ).toContain("### Details\n\n## Next");
  });

  test("a body starting with the same heading doesn't repeat it", () => {
    const result = applyDocumentEdits(plan, "md", [
      { section: "## Next", content: "## Next\n\nSoon.\n" },
    ]);
    expect(result).toEndWith("Nested.\n\n## Next\n\nSoon.\n");
  });

  test("matches a heading of any level by text alone, ignoring closing #s and extra spaces", () => {
    expect(
      applyDocumentEdits("# A\n\n##  Next  ##\nold\n", "md", [
        { section: "Next", content: "new" },
      ]),
    ).toBe("# A\n\n##  Next  ##\n\nnew\n");
  });

  test("closing #s: dropped after a space, kept when part of the text", () => {
    expect(
      markdownHeadings(
        "# A #\n## B ##   \n### C#\n#### #\n##### \t\n# D \\#\n",
      ).map((h) => [h.level, h.text]),
    ).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C#"],
      [4, ""],
      [5, ""],
      [1, "D \\#"],
    ]);
  });

  test("a heading line with a long run of spaces takes linear time (ST-150)", () => {
    for (const line of [
      "# a" + " ".repeat(200_000) + "b",
      "# a" + " ".repeat(200_000) + "#",
      "#" + " \t".repeat(100_000) + "x",
    ]) {
      const start = performance.now();
      markdownHeadings(line);
      errorOf(() =>
        applyDocumentEdits(line, "md", [{ section: "Zzz", content: "x" }]),
      );
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  test("a missing section is a conflict; a heading inside code doesn't count", () => {
    const text = "# A\n\n```md\n## Hidden\n```\n";
    expect(markdownHeadings(text).map((h) => h.text)).toEqual(["A"]);
    expect(
      errorOf(() =>
        applyDocumentEdits(text, "md", [
          { section: "## Hidden", content: "x" },
        ]),
      ),
    ).toMatchObject({
      code: "conflict",
      message: expect.stringContaining('no section "## Hidden"'),
    });
  });

  test("an ambiguous section or an HTML document is a validation error", () => {
    expect(
      errorOf(() =>
        applyDocumentEdits("## A\n1\n## A\n2\n", "md", [
          { section: "## A", content: "x" },
        ]),
      ),
    ).toMatchObject({
      code: "validation",
      message: expect.stringContaining("2 sections"),
    });
    expect(
      errorOf(() =>
        applyDocumentEdits("<h2>A</h2>", "html", [
          { section: "## A", content: "x" },
        ]),
      ),
    ).toMatchObject({
      code: "validation",
    });
  });
});

describe("applyDocumentEdits: section bodies", () => {
  test("a CRLF document keeps CRLF line endings", () => {
    const crlf = "# Plan\r\n\r\n## A\r\n\r\nold\r\n\r\n## B\r\n\r\nb\r\n";
    const edited = applyDocumentEdits(crlf, "md", [
      { section: "## A", content: "one\ntwo\r\n" },
    ]);
    expect(edited).toBe(
      "# Plan\r\n\r\n## A\r\n\r\none\r\ntwo\r\n\r\n## B\r\n\r\nb\r\n",
    );
    expect(edited.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("an LF document takes the body with LF line endings", () => {
    expect(
      applyDocumentEdits("## A\n\nold\n", "md", [
        { section: "## A", content: "one\r\ntwo" },
      ]),
    ).toBe("## A\n\none\ntwo\n");
  });

  test("a body with a heading of the same or a higher level is refused", () => {
    for (const heading of ["## Other", "# Top"]) {
      expect(
        errorOf(() =>
          applyDocumentEdits(plan, "md", [
            { section: "## Next", content: `Soon.\n\n${heading}\n\nx` },
          ]),
        ),
      ).toMatchObject({
        code: "validation",
        message: expect.stringContaining("would end the section"),
      });
    }
  });

  test("a lower-level heading, or one in a code fence, is fine", () => {
    expect(
      applyDocumentEdits("## A\n\nold\n", "md", [
        {
          section: "## A",
          content: "### Sub\n\nx\n\n```\n# not a heading\n```",
        },
      ]),
    ).toBe("## A\n\n### Sub\n\nx\n\n```\n# not a heading\n```\n");
  });

  test("a body that leaves a code fence open is refused (ST-123)", () => {
    for (const content of ["x\n\n```ts\nconst a = 1;", "~~~\ncode\n```"]) {
      expect(
        errorOf(() =>
          applyDocumentEdits(plan, "md", [{ section: "## Next", content }]),
        ),
      ).toMatchObject({
        code: "validation",
        message: expect.stringContaining("leaves a code fence open"),
      });
    }
  });

  test("a fence closes only on a line of its character, at least as long, with nothing after (ST-123)", () => {
    // Four backticks aren't closed by three, nor by a line with an info string after them.
    for (const content of [
      "````md\n```\nnot closed\n```",
      "```\ncode\n``` ts",
    ]) {
      const fence = content.split(/[a-z\n]/)[0] ?? "";
      expect(
        errorOf(() =>
          applyDocumentEdits(plan, "md", [{ section: "## Next", content }]),
        ),
      ).toMatchObject({
        code: "validation",
        message: expect.stringContaining(
          `Close it with a line of at least ${fence.length} backticks (${fence}), followed by nothing but spaces`,
        ),
      });
    }
    expect(
      applyDocumentEdits(plan, "md", [
        { section: "## Next", content: "~~~~\n~~~\n~~~~~" },
      ]),
    ).toContain("~~~~\n~~~\n~~~~~");
  });
});

describe("documentEditSchema", () => {
  test("texts are limited in UTF-8 bytes, not characters (ST-123)", () => {
    const fits = "é".repeat(MAX_DOCUMENT_BYTES / 2);
    expect(documentEditSchema.safeParse({ append: fits }).success).toBe(true);
    for (const edit of [
      { append: `${fits}é` },
      { old: "a", new: `${fits}é` },
      { section: "## A", content: `${fits}é` },
    ])
      expect(documentEditSchema.safeParse(edit).success).toBe(false);
  });

  test("a text over the limit in characters is reported once (ST-148)", () => {
    const parsed = createDocumentInput.safeParse({
      title: "Big",
      content: "x".repeat(MAX_DOCUMENT_BYTES + 1),
    });
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([
      "At most 1 MB",
    ]);
  });

  test("texts keep maxLength in the JSON schema (OpenAPI, MCP)", () => {
    expect(
      JSON.stringify(z.toJSONSchema(documentEditSchema, { io: "input" })),
    ).toContain(`"maxLength":${MAX_DOCUMENT_BYTES}`);
  });
});

describe("applyDocumentEdits: several edits", () => {
  test("apply in order", () => {
    expect(
      applyDocumentEdits("a", "md", [{ append: "b" }, { old: "b", new: "c" }]),
    ).toBe("a\nc");
  });

  test("name the failing edit", () => {
    expect(
      errorOf(() =>
        applyDocumentEdits("a", "md", [
          { append: "b" },
          { old: "z", new: "c" },
        ]),
      ),
    ).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/^Edit 2: /),
    });
  });
});
