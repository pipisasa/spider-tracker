import { describe, expect, test } from "bun:test";
import type { DiffLineDto } from "./contracts";
import {
  diffHunks,
  diffLines,
  formatUnifiedDiff,
  range,
  splitLines,
  textChanges,
  truncateHunks,
} from "./diff";

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

  test("CRLF line endings read as LF (ST-129)", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\n\r\nb")).toEqual(["a", "", "b"]);
  });
});

describe("textChanges", () => {
  test("a final newline added or removed", () => {
    expect(textChanges("a\n", "a")).toEqual({
      trailingNewlineChanged: true,
      lineEndingsChanged: false,
    });
    expect(textChanges("a", "a\nb\n").trailingNewlineChanged).toBe(true);
    expect(textChanges("", "a\n").trailingNewlineChanged).toBe(false);
    expect(textChanges("a\n", "b\n").trailingNewlineChanged).toBe(false);
  });

  test("line endings switched between CRLF and LF", () => {
    expect(textChanges("a\r\nb\r\n", "a\nb\n")).toEqual({
      trailingNewlineChanged: false,
      lineEndingsChanged: true,
    });
    expect(textChanges("a", "a\r\n").lineEndingsChanged).toBe(false);
  });

  test("a mixed text against an all-CRLF or all-LF one counts (ST-147)", () => {
    const mixed = "a\r\nb\nc\r\n";
    expect(textChanges(mixed, "a\r\nb\r\nc\r\n").lineEndingsChanged).toBe(true);
    expect(textChanges("a\nb\n", mixed).lineEndingsChanged).toBe(true);
    expect(textChanges(mixed, "x\r\ny\nz\n").lineEndingsChanged).toBe(false);
    expect(textChanges("a\r\n", "a\r\nb\r\n").lineEndingsChanged).toBe(false);
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

describe("diffLines on long documents (ST-129)", () => {
  test("a CRLF and an LF version of the same text have no changes", () => {
    const lf = "# Plan\n\nOne.\nTwo.\n";
    const lines = diffLines(lf.replace(/\n/g, "\r\n"), lf);
    expect(lines.every((l) => l.kind === "context")).toBe(true);
    expect(diffHunks(lines)).toEqual([]);
  });

  test("a thousand scattered one-line edits stay one-line edits", () => {
    const old = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
    const edited = old.map((line, i) =>
      i % 100 === 50 ? `${line} edited` : line,
    );
    const started = performance.now();
    const lines = diffLines(old.join("\n"), edited.join("\n"));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(lines.filter((l) => l.kind === "removed")).toHaveLength(1000);
    expect(lines.filter((l) => l.kind === "added")).toHaveLength(1000);
    expect(sides(lines)).toEqual({ old, new: edited });
    const hunks = diffHunks(lines);
    expect(hunks).toHaveLength(1000);
    expect(hunks[1]).toMatchObject({
      oldStart: 148,
      oldLines: 7,
      newStart: 148,
      newLines: 7,
    });
  });

  test("scattered edits among repeated lines still rebuild both texts", () => {
    const old = Array.from({ length: 6000 }, (_, i) =>
      i % 3 === 0 ? "" : `p${i % 7}-${Math.floor(i / 3)}`,
    );
    const edited = old.flatMap((line, i) =>
      i % 50 === 0 ? [line, `new ${i}`] : i % 77 === 0 ? [] : [line],
    );
    const lines = diffLines(old.join("\n"), edited.join("\n"));
    expect(sides(lines)).toEqual({ old, new: edited });
    expect(lines.filter((l) => l.kind !== "context").length).toBeLessThan(400);
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

  test("range writes start,count, or just start for one line", () => {
    expect(range(3, 1)).toBe("3");
    expect(range(3, 2)).toBe("3,2");
    expect(range(0, 0)).toBe("0,0");
  });

  test("truncateHunks keeps whole hunks, then cuts the last one short", () => {
    const edited = old.map((line, i) => (i % 10 === 0 ? `${line}!` : line));
    const hunks = diffHunks(diffLines(old.join("\n"), edited.join("\n")));
    expect(truncateHunks(hunks, 1000)).toEqual({ hunks, truncated: false });
    const total = hunks.reduce((n, h) => n + h.lines.length, 0);
    const cut = truncateHunks(hunks, total - 3);
    expect(cut.truncated).toBe(true);
    const last = cut.hunks.at(-1)!;
    expect(last.lines).toHaveLength(hunks.at(-1)!.lines.length - 3);
    expect(last.oldStart).toBe(hunks.at(-1)!.oldStart);
    expect(last.oldLines).toBe(
      last.lines.filter((l) => l.kind !== "added").length,
    );
  });

  test("truncateHunks also caps the characters, cutting a long line short (ST-147)", () => {
    const hunks = diffHunks(diffLines("x".repeat(100), "y".repeat(100)));
    expect(truncateHunks(hunks, 1000, 200)).toEqual({
      hunks,
      truncated: false,
    });
    const cut = truncateHunks(hunks, 1000, 150);
    expect(cut.truncated).toBe(true);
    expect(cut.hunks[0]?.lines.map((l) => [l.kind, l.text.length])).toEqual([
      ["removed", 100],
      ["added", 50],
    ]);
    expect(cut.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 });
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
