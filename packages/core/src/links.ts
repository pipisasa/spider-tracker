// Links between documents (ST-100), Obsidian style. Browser-safe (no database): the web
// editor, the Markdown renderer and the server all parse and resolve links the same way.
import { taskKeysIn } from "./git";
import { isUuid } from "./ids";
import { parseTaskKey } from "./schemas";

/** A `[[target]]` or `[[target|label]]` link as written. */
export interface WikiLink {
  /** What the link points at: a document title or a task key, without a `#heading` part. */
  target: string;
  /** The text shown instead of the target, if any. */
  label: string | null;
}

/** `[[target]]`, `[[target#heading]]`, `[[target|label]]`; no brackets or line breaks inside. */
export const WIKI_LINK = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]*))?\]\]/g;

/** A title as links match it: trimmed, inner whitespace collapsed, lower-case. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Splits `[[target#heading|label]]`'s inside into its parts; null when the target is empty. */
export function parseWikiLink(
  inner: string,
  label?: string | null,
): WikiLink | null {
  const target = (inner.split("#")[0] ?? "").trim();
  if (!target) return null;
  const shown = label?.trim();
  return { target, label: shown ? shown : null };
}

/**
 * A fenced code block: indented up to 3 spaces (as in a list item), closed by a line of the same
 * character at least as long, or running to the end.
 */
const FENCE =
  /^ {0,3}((`)\2{2,}|(~)\3{2,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1(?:\2|\3)*[^\S\n]*$|(?![\s\S]))/gm;

/** Where code is in a text, as `[start, end)` ranges in order. */
type Ranges = Array<[number, number]>;

/**
 * HTML elements of these names (lower-case), from the opening tag to the first closing tag of the
 * same name, any case. One pass: a regex rescanned to the end for every unclosed tag (ST-134).
 */
export function elementRanges(
  text: string,
  names: readonly string[],
): Array<[number, number]> {
  const ranges: Ranges = [];
  // The last `>` found, and the tag names no closing tag follows any more.
  let gt = -1;
  const unclosed = new Set<string>();
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const name = (match[1] ?? "").toLowerCase();
    const afterName = match.index + match[0].length;
    if (gt < afterName) gt = text.indexOf(">", afterName);
    if (gt < 0) break; // No `>` left, so no tag can open.
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}>`, "gi");
    close.lastIndex = gt + 1;
    const found = close.exec(text);
    if (!found) {
      unclosed.add(name);
      continue;
    }
    const end = found.index + found[0].length;
    ranges.push([match.index, end]);
    open.lastIndex = end;
  }
  return ranges;
}

/** A run of backticks: where it starts and how many. */
interface BacktickRun {
  start: number;
  length: number;
}

/** Pairs a paragraph's backtick runs into code spans, in order, adding them to `ranges`. */
function pairRuns(runs: BacktickRun[], ranges: Ranges): void {
  // Per length, the indexes of the runs of that length, and the first one not yet passed.
  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const list = byLength.get(run.length);
    if (list) list.push(index);
    else byLength.set(run.length, [index]);
  });
  const passed = new Map<number, number>();
  for (let i = 0; i < runs.length;) {
    const run = runs[i];
    if (!run) break;
    const list = byLength.get(run.length) ?? [];
    let next = passed.get(run.length) ?? 0;
    while (next < list.length && (list[next] ?? Infinity) <= i) next++;
    passed.set(run.length, next);
    const closer = list[next];
    const closing = closer === undefined ? undefined : runs[closer];
    if (closer === undefined || !closing) {
      i++; // Unpaired: literal backticks.
      continue;
    }
    ranges.push([run.start, closing.start + closing.length]);
    i = closer + 1;
  }
}

/**
 * Inline code spans, as in CommonMark: a run of backticks is closed by the next run of exactly as
 * many backticks in the same paragraph (no blank line in between); a run left unpaired is literal.
 * Linear: one pass collects the runs, then each paragraph pairs them by length (ST-134: a regex
 * rescanned the paragraph for every unpaired run).
 */
function codeSpanRanges(text: string): Ranges {
  const ranges: Ranges = [];
  let runs: BacktickRun[] = [];
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === "`") {
      let end = i + 1;
      while (text[end] === "`") end++;
      runs.push({ start: i, length: end - i });
      i = end;
      continue;
    }
    if (char === "\n") {
      // A blank line (only whitespace up to the next line break) ends the paragraph.
      let j = i + 1;
      while (j < text.length && text[j] !== "\n" && /\s/.test(text[j] ?? ""))
        j++;
      if (text[j] === "\n") {
        pairRuns(runs, ranges);
        runs = [];
      }
    }
    i++;
  }
  pairRuns(runs, ranges);
  return ranges;
}

/** `text` with each range replaced by what `replace` makes of it. */
function replaceRanges(
  text: string,
  ranges: Ranges,
  replace: (code: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const [start, end] of ranges) {
    out += text.slice(last, start) + replace(text.slice(start, end));
    last = end;
  }
  return out + text.slice(last);
}

/**
 * `text` with its code replaced, in the order it is taken out: fenced blocks, HTML <pre>/<code>
 * elements, inline code spans. Each step is linear in the length of the text (ST-134).
 */
function replaceCode(text: string, replace: (code: string) => string): string {
  const unfenced = text.replace(FENCE, replace);
  const unhtml = replaceRanges(
    unfenced,
    elementRanges(unfenced, ["pre", "code"]),
    replace,
  );
  return replaceRanges(unhtml, codeSpanRanges(unhtml), replace);
}

/** Text without code: fenced blocks, inline code spans and HTML <pre>/<code> elements. */
function withoutCode(text: string): string {
  return replaceCode(text, () => " ");
}

/** The same code blanked out with spaces instead, so offsets into the text still hold. */
export function maskCode(text: string): string {
  return replaceCode(text, (code) => code.replace(/[^\n]/g, " "));
}

/**
 * Whether `[[title]]` links to a document of this title: not when it holds `[`, `]`, `|` or `#`
 * (they end the link or start a label or heading), or reads as a task key or a `doc:<id>`.
 */
export function isLinkableTitle(title: string): boolean {
  return (
    title.trim() !== "" &&
    !/[[\]|#\n]/.test(title) &&
    !taskKeyTarget(title) &&
    !documentIdTarget(title)
  );
}

/**
 * `content` with its `[[oldTitle]]` links (any case or spacing, keeping a `#heading` and a
 * `|label`) leading to `newTarget` instead: a new title or a `doc:<id>` (ST-101). Links in code
 * stay as written.
 */
export function retargetTitleLinks(
  content: string,
  oldTitle: string,
  newTarget: string,
): string {
  const wanted = normalizeTitle(oldTitle);
  let out = "";
  let last = 0;
  for (const match of maskCode(content).matchAll(WIKI_LINK)) {
    const inner = match[1] ?? "";
    const hash = inner.indexOf("#");
    const target = hash < 0 ? inner : inner.slice(0, hash);
    if (
      normalizeTitle(target) !== wanted ||
      taskKeyTarget(target) ||
      documentIdTarget(target)
    )
      continue;
    // What follows the target as written: `#heading`, then `|label]]` or `]]`.
    const end = match.index + match[0].length;
    const rest = content.slice(match.index + 2 + target.length, end);
    out += `${content.slice(last, match.index)}[[${newTarget}${rest}`;
    last = end;
  }
  return last ? out + content.slice(last) : content;
}

/** Every wiki link in `text`, in order, code excluded. */
export function wikiLinksIn(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of withoutCode(text).matchAll(WIKI_LINK)) {
    const link = parseWikiLink(match[1] ?? "", match[2]);
    if (link) links.push(link);
  }
  return links;
}

/** The task key a wiki-link target names ("st-12" → "ST-12"), or null for a document title. */
export function taskKeyTarget(target: string): string | null {
  const parsed = parseTaskKey(target.trim());
  return parsed ? `${parsed.projectKey}-${parsed.number}` : null;
}

/** The prefix of a link by document id: `[[doc:<id>]]` (ST-115). */
const DOC_ID_PREFIX = "doc:";

/**
 * The document id a `[[doc:<id>]]` target names (lower-cased), or null for anything else. A link
 * by id survives renames and shows the document's current title.
 */
export function documentIdTarget(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed.slice(0, DOC_ID_PREFIX.length).toLowerCase() !== DOC_ID_PREFIX)
    return null;
  const id = trimmed.slice(DOC_ID_PREFIX.length).trim();
  return isUuid(id) ? id.toLowerCase() : null;
}

/** How a link by id is written (and stored as a link target): `doc:<id>`. */
export function documentIdLink(id: string): string {
  return `${DOC_ID_PREFIX}${id.toLowerCase()}`;
}

/** What a document links to, without repeats: document titles (as first written), document ids and task keys. */
export interface OutgoingLinks {
  documents: string[];
  /** Ids from `[[doc:<id>]]`, lower-cased. */
  documentIds: string[];
  tasks: string[];
}

/**
 * The links a document's content makes: `[[Title]]` and `[[doc:<id>]]` to documents, `[[ST-12]]` and plain
 * task keys ("see ST-12") to tasks. Code is ignored. Task keys are syntactic only; readers
 * keep the ones that exist.
 */
export function outgoingLinksIn(content: string): OutgoingLinks {
  // Keyed by the normalized title, keeping the first spelling.
  const documents = new Map<string, string>();
  const documentIds = new Set<string>();
  const tasks = new Set<string>();
  const text = withoutCode(content);
  for (const match of text.matchAll(WIKI_LINK)) {
    const link = parseWikiLink(match[1] ?? "", match[2]);
    if (!link) continue;
    const key = taskKeyTarget(link.target);
    const id = documentIdTarget(link.target);
    if (key) tasks.add(key);
    else if (id) documentIds.add(id);
    else {
      const key = normalizeTitle(link.target);
      if (!documents.has(key))
        documents.set(key, link.target.replace(/\s+/g, " "));
    }
  }
  // Plain mentions, outside wiki links (a document titled "ST-1 notes" isn't a mention).
  for (const key of taskKeysIn(text.replace(WIKI_LINK, " "))) tasks.add(key);
  return {
    documents: [...documents.values()],
    documentIds: [...documentIds],
    tasks: [...tasks],
  };
}

/** The fields title resolution needs. */
export interface LinkCandidate {
  id: string;
  title: string;
  projectKey: string | null;
  updatedAt: string;
}

/**
 * The document a `[[title]]` written in a document of `fromProjectKey` opens. Titles needn't be
 * unique: the same project's document wins, then an organization-wide one, then the most
 * recently updated. Null when nothing matches.
 */
export function resolveTitle<T extends LinkCandidate>(
  candidates: readonly T[],
  title: string,
  fromProjectKey: string | null,
): T | null {
  const wanted = normalizeTitle(title);
  let best: T | null = null;
  let bestRank = -1;
  for (const doc of candidates) {
    if (normalizeTitle(doc.title) !== wanted) continue;
    const rank =
      doc.projectKey === fromProjectKey ? 2 : doc.projectKey === null ? 1 : 0;
    if (
      rank > bestRank ||
      (rank === bestRank && best && doc.updatedAt > best.updatedAt)
    ) {
      best = doc;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * The document a `[[target]]` (a title or `doc:<id>`) written in a document of `fromProjectKey`
 * opens, among `candidates`; null when none matches.
 */
export function resolveDocumentLink<T extends LinkCandidate>(
  candidates: readonly T[],
  target: string,
  fromProjectKey: string | null,
): T | null {
  const id = documentIdTarget(target);
  if (id) return candidates.find((doc) => doc.id.toLowerCase() === id) ?? null;
  return resolveTitle(candidates, target, fromProjectKey);
}
