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
export function parseWikiLink(inner: string, label?: string | null): WikiLink | null {
  const target = (inner.split("#")[0] ?? "").trim();
  if (!target) return null;
  const shown = label?.trim();
  return { target, label: shown ? shown : null };
}

/** Text without code: fenced blocks, inline code spans and HTML <pre>/<code> elements. */
function withoutCode(text: string): string {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\S\n]*$|(?![\s\S]))/gm, " ")
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ");
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
      if (!documents.has(key)) documents.set(key, link.target.replace(/\s+/g, " "));
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
    const rank = doc.projectKey === fromProjectKey ? 2 : doc.projectKey === null ? 1 : 0;
    if (rank > bestRank || (rank === bestRank && best && doc.updatedAt > best.updatedAt)) {
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
