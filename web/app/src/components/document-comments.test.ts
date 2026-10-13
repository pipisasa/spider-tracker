import { expect, test } from "bun:test";
import type { DocumentCommentDto } from "@repo/core/contracts";
import { locateQuote, threadsOf } from "./document-comments";

const comment = (
  id: string,
  parentId: string | null = null,
): DocumentCommentDto => ({
  id,
  documentId: "d",
  parentId,
  authorId: "a",
  body: id,
  quote: null,
  outdated: false,
  documentVersion: 1,
  resolvedAt: null,
  resolvedBy: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  editedAt: null,
});

test("threads: replies at any depth sit under their first comment", () => {
  const threads = threadsOf([
    comment("a"),
    comment("b"),
    comment("a1", "a"),
    comment("a2", "a1"),
    comment("b1", "b"),
  ]);
  expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
    ["a", ["a1", "a2"]],
    ["b", ["b1"]],
  ]);
});

test("a quote is found across text nodes, ignoring markup and spacing between words", () => {
  // As rendered from "We ship **the API** first.": three text nodes.
  const pieces = ["We ship ", "the API", " first."];
  expect(locateQuote(pieces, "ship the API  first")).toEqual({
    start: { piece: 0, offset: 3 },
    end: { piece: 2, offset: 6 },
  });
  expect(locateQuote(pieces, "the API")).toEqual({
    start: { piece: 1, offset: 0 },
    end: { piece: 1, offset: 7 },
  });
  expect(locateQuote(pieces, "the UI")).toBeNull();
  expect(locateQuote(pieces, "…")).toBeNull();
});
