import { Editor } from "@tiptap/core";
import { describe, expect, test } from "bun:test";
import { markdownExtensions } from "./extensions";

function roundTrip(markdown: string): string {
  const editor = new Editor({
    element: null,
    extensions: markdownExtensions(),
    content: markdown,
    contentType: "markdown",
  });
  const out = editor.getMarkdown();
  editor.destroy();
  return out;
}

const samples: Record<string, string> = {
  headings: "# One\n\n## Two\n\n### Three\n\nParagraph text.",
  marks:
    "Some **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.com).",
  "bullet list": "- one\n- two\n  - nested\n- three",
  "ordered list": "1. first\n2. second\n3. third",
  "task list": "- [ ] todo\n- [x] done\n  - [ ] nested",
  quote: "> a quote\n> on two lines",
  "code block": "```ts\nconst a = 1;\n\nfunction f() {\n  return a;\n}\n```",
  divider: "Above\n\n---\n\nBelow",
  image: "![Diagram](https://example.com/d.png)",
  table: "| A | B |\n| --- | --- |\n| 1 | **2** |\n| x | [y](https://y.dev) |",
  mixed:
    "# Spec\n\nIntro with *emphasis*.\n\n- [x] shipped\n- [ ] pending\n\n> Note: `inline`\n\n1. a\n2. b\n\n```\nplain\n```\n\n| H |\n| --- |\n| c |\n",
};

describe("markdown round-trip", () => {
  for (const [name, markdown] of Object.entries(samples)) {
    test(name, () => {
      const first = roundTrip(markdown);
      expect(roundTrip(first)).toBe(first);
    });
  }

  test("keeps the content of each construct", () => {
    const out = roundTrip(Object.values(samples).join("\n\n"));
    for (const fragment of [
      "# One",
      "### Three",
      "**bold**",
      "*italic*",
      "~~strike~~",
      "`code`",
      "[link](https://example.com)",
      "  - nested",
      "2. second",
      "- [ ] todo",
      "- [x] done",
      "> a quote",
      "```ts",
      "---",
      "| A",
      "[y](https://y.dev)",
      "![Diagram](https://example.com/d.png)",
    ])
      expect(out).toContain(fragment);
  });
});
