// Line diffs of document versions (ST-117). Browser-safe (no database): the API computes
// diffs with it, the CLI prints them as unified diffs.
import type { DiffHunkDto, DiffLineDto } from "./contracts";

/** Lines of context around each change, as in `diff -u`. */
export const DIFF_CONTEXT = 3;

/**
 * Past this many differing lines Myers' search is cut short and the differing middle is shown
 * as removed, then added: still a correct diff, just not the shortest. Bounds time and memory
 * (the search keeps about MAX_EDITS² numbers) on unrelated 1 MB texts.
 */
const MAX_EDITS = 2000;

/** "a\nb\n" → ["a", "b"]; a missing final newline doesn't count as a change of its own. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = "equal" | "insert" | "delete";

/**
 * Myers' O(ND) diff of two integer sequences: the shortest edit script, as one op per element
 * (equal consumes one of each, delete one of `a`, insert one of `b`). Null past `maxEdits`.
 */
function myers(a: Int32Array, b: Int32Array, maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d][k + d] is the furthest x on diagonal k after d edits.
  const trace: Int32Array[] = [];
  const at = (d: number, k: number) => trace[d]![k + d]!;
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      // Backtracking reads only the rounds before this one.
      if (x >= n && y >= m) return backtrack(at, d, n, m);
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

function backtrack(
  at: (d: number, k: number) => number,
  edits: number,
  n: number,
  m: number,
): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const k = x - y;
    const down = k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(d - 1, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("equal");
      x--;
      y--;
    }
    ops.push(down ? "insert" : "delete");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push("equal");
    x--;
    y--;
  }
  return ops.reverse();
}

/** Every line of both texts in order: unchanged, removed and added, with their line numbers. */
export function diffLines(oldText: string, newText: string): DiffLineDto[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  // Compare lines as numbers: equal lines get the same id.
  const ids = new Map<string, number>();
  const idsOf = (lines: string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) ids.set(line, (id = ids.size));
      return id;
    });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = myers(idsOf(midA), idsOf(midB), MAX_EDITS) ?? [
    ...midA.map((): Op => "delete"),
    ...midB.map((): Op => "insert"),
  ];

  const lines: DiffLineDto[] = [];
  let i = 0;
  let j = 0;
  const context = () =>
    lines.push({ kind: "context", text: a[i]!, oldLine: ++i, newLine: ++j });
  while (i < start) context();
  for (const op of ops) {
    if (op === "equal") context();
    else if (op === "delete")
      lines.push({ kind: "removed", text: a[i]!, oldLine: ++i, newLine: null });
    else
      lines.push({ kind: "added", text: b[j]!, oldLine: null, newLine: ++j });
  }
  while (i < a.length) context();
  return lines;
}

/** Groups the changes of a full line diff into hunks with `context` lines around them. */
export function diffHunks(
  lines: DiffLineDto[],
  context = DIFF_CONTEXT,
): DiffHunkDto[] {
  const changed: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== "context") changed.push(index);
  });
  const hunks: DiffHunkDto[] = [];
  let g = 0;
  while (g < changed.length) {
    // Changes closer than 2 × context share a hunk.
    let last = g;
    while (
      last + 1 < changed.length &&
      changed[last + 1]! - changed[last]! - 1 <= 2 * context
    )
      last++;
    const from = Math.max(0, changed[g]! - context);
    const to = Math.min(lines.length, changed[last]! + context + 1);
    const slice = lines.slice(from, to);
    // Lines of each text before the hunk: what's numbered before its first line.
    let oldBefore = 0;
    let newBefore = 0;
    for (const line of lines.slice(0, from)) {
      if (line.oldLine !== null) oldBefore = line.oldLine;
      if (line.newLine !== null) newBefore = line.newLine;
    }
    const oldLines = slice.filter((l) => l.kind !== "added").length;
    const newLines = slice.filter((l) => l.kind !== "removed").length;
    hunks.push({
      oldStart: oldLines ? oldBefore + 1 : oldBefore,
      oldLines,
      newStart: newLines ? newBefore + 1 : newBefore,
      newLines,
      lines: slice,
    });
    g = last + 1;
  }
  return hunks;
}

const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${start},${count}`;

const PREFIX: Record<DiffLineDto["kind"], string> = {
  context: " ",
  added: "+",
  removed: "-",
};

/** A unified diff (`diff -u` style), with `fromLabel` and `toLabel` on the `---`/`+++` lines; "" without hunks. */
export function formatUnifiedDiff(
  hunks: DiffHunkDto[],
  fromLabel: string,
  toLabel: string,
): string {
  if (!hunks.length) return "";
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    );
    for (const line of hunk.lines) out.push(`${PREFIX[line.kind]}${line.text}`);
  }
  return out.join("\n");
}
