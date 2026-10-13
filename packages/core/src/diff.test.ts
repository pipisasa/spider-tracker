import { describe, expect, test } from "bun:test";
import type { DiffLineDto } from "./contracts";
import { diffHunks, diffLines, formatUnifiedDiff, splitLines } from "./diff";

/** The diff as `diff -u` body lines, without line numbers. */
const marks = (lines: DiffLineDto[]) =>
  lines.map(
    (l) =>
      `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`,
  );

/** Rebuilds both texts from a diff: what every correct diff must satisfy. */
function sides(lines: DiffLineDto[]) {
  return {
    old: lines.filter((l) => l.kind !== "added").map((l) => l.text),
    new: lines.filter((l) => l.kind !== "removed").map((l) => l.text),
  };
}

describe("splitLines", () => {
  test("a final newline ends the last line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("diffLines", () => {
  test("identical texts are all context", () => {
    const lines = diffLines("a\nb\n", "a\nb\n");
    expect(lines.every((l) => l.kind === "context")).toBe(true);
    expect(lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  test("a changed line is removed, then added, with line numbers", () => {
    expect(diffLines("# Plan\nold step\nend", "# Plan\nnew step\nend")).toEqual(
      [
        { kind: "context", text: "# Plan", oldLine: 1, newLine: 1 },
        { kind: "removed", text: "old step", oldLine: 2, newLine: null },
        { kind: "added", text: "new step", oldLine: null, newLine: 2 },
        { kind: "context", text: "end", oldLine: 3, newLine: 3 },
      ],
    );
  });

  test("from and to empty texts", () => {
    expect(marks(diffLines("", "a\nb"))).toEqual(["+a", "+b"]);
    expect(marks(diffLines("a\nb", ""))).toEqual(["-a", "-b"]);
    expect(diffLines("", "")).toEqual([]);
  });

  test("finds the shortest edit (keeps the common lines)", () => {
    // The classic Myers example: ABCABBA → CBABAC takes 5 edits.
    const lines = diffLines("A\nB\nC\nA\nB\nB\nA", "C\nB\nA\nB\nA\nC");
    expect(lines.filter((l) => l.kind !== "context")).toHaveLength(5);
    expect(sides(lines)).toEqual({
      old: ["A", "B", "C", "A", "B", "B", "A"],
      new: ["C", "B", "A", "B", "A", "C"],
    });
  });

  test("insertions and deletions in the middle", () => {
    const a = "one\ntwo\nthree\nfour\nfive";
    const b = "one\ntwo and a half\nthree\nfive\nsix";
    expect(sides(diffLines(a, b))).toEqual({
      old: splitLines(a),
      new: splitLines(b),
    });
    expect(marks(diffLines(a, b))).toEqual([
      " one",
      "-two",
      "+two and a half",
      " three",
      "-four",
      " five",
      "+six",
    ]);
  });

  test("random edits always rebuild both texts", () => {
    let seed = 7;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const a = Array.from(
        { length: Math.floor(random() * 30) },
        () => "abcde"[Math.floor(random() * 5)]!,
      );
      const b = a.flatMap((line) => {
        const r = random();
        if (r < 0.15) return [];
        if (r < 0.3) return [line, "xyz"[Math.floor(random() * 3)]!];
        return [line];
      });
      const lines = diffLines(a.join("\n"), b.join("\n"));
      expect(sides(lines)).toEqual({ old: a, new: b });
    }
  });

  test("very different large texts fall back to remove-all, add-all", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const lines = diffLines(`head\n${a}\ntail`, `head\n${b}\ntail`);
    expect(lines).toHaveLength(6002);
    expect(sides(lines).new).toHaveLength(3002);
    expect(lines[0]).toMatchObject({ kind: "context", text: "head" });
    expect(lines[1]).toMatchObject({ kind: "removed", text: "a0" });
    expect(lines[3001]).toMatchObject({
      kind: "added",
      text: "b0",
      newLine: 2,
    });
    expect(lines.at(-1)).toMatchObject({
      kind: "context",
      text: "tail",
      oldLine: 3002,
      newLine: 3002,
    });
  });
});

describe("diffHunks and formatUnifiedDiff", () => {
  const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

  test("no changes, no hunks", () => {
    expect(diffHunks(diffLines("a\nb", "a\nb"))).toEqual([]);
    expect(formatUnifiedDiff([], "a", "b")).toBe("");
  });

  test("distant changes get their own hunks with 3 lines of context", () => {
    const next = [...old];
    next[1] = "changed 2";
    next[17] = "changed 18";
    const hunks = diffHunks(diffLines(old.join("\n"), next.join("\n")));
    expect(
      hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]),
    ).toEqual([
      [1, 5, 1, 5],
      [15, 6, 15, 6],
    ]);
    expect(formatUnifiedDiff(hunks, "v1", "v2")).toBe(
      [
        "--- v1",
        "+++ v2",
        "@@ -1,5 +1,5 @@",
        " line 1",
        "-line 2",
        "+changed 2",
        " line 3",
        " line 4",
        " line 5",
        "@@ -15,6 +15,6 @@",
        " line 15",
        " line 16",
        " line 17",
        "-line 18",
        "+changed 18",
        " line 19",
        " line 20",
      ].join("\n"),
    );
  });

  test("close changes share a hunk", () => {
    const next = [...old];
    next[4] = "changed 5";
    next[10] = "changed 11";
    const hunks = diffHunks(diffLines(old.join("\n"), next.join("\n")));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      oldStart: 2,
      oldLines: 13,
      newStart: 2,
      newLines: 13,
    });
  });

  test("pure insertions and deletions number like diff -u", () => {
    const added = diffHunks(diffLines("", "a\nb"));
    expect(formatUnifiedDiff(added, "x", "y")).toBe(
      "--- x\n+++ y\n@@ -0,0 +1,2 @@\n+a\n+b",
    );
    const removed = diffHunks(diffLines("a", ""));
    expect(formatUnifiedDiff(removed, "x", "y")).toBe(
      "--- x\n+++ y\n@@ -1 +0,0 @@\n-a",
    );
  });
});
