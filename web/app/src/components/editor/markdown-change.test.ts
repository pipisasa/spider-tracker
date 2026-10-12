import { describe, expect, test } from "bun:test";
import { markdownChanged } from "./markdown-change";

describe("markdownChanged", () => {
  test("identical", () => expect(markdownChanged("- a", "- a")).toBe(false));
  test("trailing empty paragraph from TrailingNode", () => {
    expect(markdownChanged("- a", "- a\n\n")).toBe(false);
    expect(markdownChanged("- a\n", "- a")).toBe(false);
  });
  test("empty document stays empty", () => expect(markdownChanged("", "\n")).toBe(false));
  test("real edit", () => expect(markdownChanged("- a", "- ab")).toBe(true));
  test("edit in leading whitespace counts", () => expect(markdownChanged("a", " a")).toBe(true));
  test("clearing the document counts", () => expect(markdownChanged("a", "")).toBe(true));
});
