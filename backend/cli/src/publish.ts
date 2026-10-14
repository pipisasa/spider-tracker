// `spider doc publish <dir>` (ST-119): a folder of Markdown files published as documents, with
// links between the files turned into tracker links. Parsing, front matter and link resolution
// are pure functions; `publishDocuments` drives the API through the SDK.
import type { DocumentDto } from "@repo/core/contracts";
import {
  WIKI_LINK,
  documentIdLink,
  documentIdTarget,
  maskCode,
  normalizeTitle,
  taskKeyTarget,
} from "@repo/core/links";
import { MAX_DOCUMENT_BYTES } from "@repo/core/schemas";
import { SpiderApiError, type SpiderClient } from "@repo/sdk";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, posix, relative, isAbsolute } from "node:path";

/**
 * The front matter keys publish reads; `id`, `version` and `hash` (of the title and body as last
 * published, ST-132) are written back after a publish.
 */
export interface FrontMatter {
  id?: string;
  version?: string;
  hash?: string;
  title?: string;
  project?: string;
  task?: string;
}

const FRONT_MATTER_KEYS = [
  "id",
  "version",
  "hash",
  "title",
  "project",
  "task",
] as const;

/** `---` on the first line, `key: value` lines, then `---` (or `...`) on a line of its own. */
const FRONT_MATTER =
  /^---[^\S\n]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[^\S\n]*(?:\r?\n|$)/m;

/** A UTF-8 byte order mark: hidden from parsing, kept when a file is written back. */
const BOM = "\uFEFF";

/** A YAML `key: value` line, the key bare or quoted (`"title": X`); the value may be empty or nested below. */
const KEY_LINE = /^(["']?)([A-Za-z_][\w-]*)\1\s*:(.*)$/;

/** A `key: value` line's key (unquoted) and raw value, or null for any other line. */
function keyLine(line: string): { key: string; value: string } | null {
  const match = KEY_LINE.exec(line);
  return match ? { key: match[2] ?? "", value: match[3] ?? "" } : null;
}

const COMMENT_LINE = /^\s*#/;

/**
 * The front matter block at the start of `text` (no BOM), or null. A block counts only when every
 * non-blank line is a `key: value` line, a comment, or an indented or `- item` line of a nested
 * value, and its first line after any leading YAML comments is a `key: value` line (not blank).
 * So a file that opens with a horizontal rule and a paragraph is all body, even a one-line
 * `Word: text` paragraph after a blank line. A block opening with `# comment` lines is front
 * matter, as YAML reads it (ST-132): a published file like `---`, `# notes`, `id: …` keeps its id,
 * even with a blank line after the comments, since a block holding an `id:` line counts anyway.
 */
function matchFrontMatter(text: string): RegExpExecArray | null {
  const match = text.startsWith("---") ? FRONT_MATTER.exec(text) : null;
  if (!match || match.index !== 0) return null;
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || COMMENT_LINE.test(line) || keyLine(line)) continue;
    if (!/^(?:\s|-(?:\s|$))/.test(line)) return null;
  }
  // The block ends with a line break, so the last element is "" (an empty block has only that).
  if (lines.length > 1) {
    const first = lines.findIndex((line) => !COMMENT_LINE.test(line));
    // Only an id that parses rescues the block: `id: see below` in a paragraph doesn't.
    const hasId = lines.some((line) => {
      const kv = keyLine(line);
      return (
        kv?.key.toLowerCase() === "id" &&
        documentIdTarget(`doc:${unquote(kv.value)}`) !== null
      );
    });
    if (!keyLine(lines[first] ?? "") && !hasId) return null;
  }
  return match;
}

/**
 * Whether `raw` opens with a front matter block that holds none of the keys publish reads: its
 * text (a `# Heading` and a `Note: …` line, say) is dropped from the content, as YAML reads it.
 */
export function frontMatterWithoutKnownKeys(raw: string): boolean {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const match = matchFrontMatter(text);
  if (!match) return false;
  const lines = (match[1] ?? "").split(/\r?\n/);
  // An empty block (`---`, `---`) drops no text.
  if (lines.every((line) => !line.trim())) return false;
  return !lines.some((line) => {
    const key = keyLine(line)?.key.toLowerCase();
    return FRONT_MATTER_KEYS.some((k) => k === key);
  });
}

/** A value without its quotes, or without a trailing ` # comment` when unquoted. */
const unquote = (value: string) => {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0])
    return v.slice(1, -1);
  return v.replace(/(?:^|\s+)#.*$/, "");
};

/**
 * Splits a file into its front matter (the keys publish knows; other lines are kept as written
 * but not read) and the document's content, without the blank lines after the front matter.
 * A leading BOM is dropped.
 */
export function parseFrontMatter(raw: string): {
  fields: FrontMatter;
  body: string;
} {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const match = matchFrontMatter(text);
  if (!match) return { fields: {}, body: text };
  const fields: FrontMatter = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = keyLine(line);
    if (!kv) continue;
    const key = kv.key.toLowerCase();
    const value = unquote(kv.value);
    const known = FRONT_MATTER_KEYS.find((k) => k === key);
    if (known && value !== "") fields[known] = value;
  }
  return {
    fields,
    body: text.slice(match[0].length).replace(/^(?:[^\S\n]*\r?\n)+/, ""),
  };
}

/**
 * `raw` with `updates` set in its front matter: an existing `key:` line is replaced, a missing key
 * is added at the end, and a file without front matter gets one. Everything else stays as written,
 * a leading BOM included.
 */
export function setFrontMatter(
  raw: string,
  updates: Record<string, string>,
): string {
  const bom = raw.startsWith(BOM) ? BOM : "";
  const text = raw.slice(bom.length);
  const match = matchFrontMatter(text);
  const entries = Object.entries(updates);
  if (!match) {
    return `${bom}---\n${entries.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${text}`;
  }
  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = (match[1] ?? "").split(/\r?\n/);
  // The block ends with a line break, so the last split element is "".
  if (lines.at(-1) === "") lines.pop();
  for (const [key, value] of entries) {
    const index = lines.findIndex(
      (line) => keyLine(line)?.key.toLowerCase() === key.toLowerCase(),
    );
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  // The opening line, the block (group 1), then the closing line.
  const head = match[0].slice(0, match[0].indexOf("\n") + 1);
  const closing = match[0].slice(head.length + (match[1] ?? "").length);
  const block = lines.length ? `${lines.join(eol)}${eol}` : "";
  return `${bom}${head}${block}${closing.endsWith("\n") ? closing : `${closing}${eol}`}${text.slice(match[0].length)}`;
}

/** A file's bytes as text, or null when they aren't valid UTF-8 (a leading BOM is kept). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

/** One Markdown file of the folder, parsed. */
export interface SourceDoc {
  /** Relative to the folder, with `/` separators. */
  path: string;
  /** The file as read (front matter included). */
  raw: string;
  id: string | null;
  /** The document version the file was last published as (`version:` in its front matter). */
  version: number | null;
  /** `hash:` from the front matter: sourceHash of the file when it was last published. */
  hash: string | null;
  /** `title:` from the front matter, or the file name without `.md`. */
  title: string;
  project: string | null;
  task: string | null;
  body: string;
}

/**
 * A short hash of a file's title and body as written (front matter and resolved links aside): it
 * tells whether the file changed since it was last published. Line endings are normalized, so a
 * checkout with other `core.autocrlf` settings hashes the same.
 */
export function sourceHash(doc: Pick<SourceDoc, "title" | "body">): string {
  return createHash("sha256")
    .update(`${doc.title.trim()}\n${doc.body}`.replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Parses one file; throws a message for an `id` or `version` that can't be right. */
export function parseSourceDoc(path: string, raw: string): SourceDoc {
  const { fields, body } = parseFrontMatter(raw);
  const id =
    fields.id === undefined ? null : documentIdTarget(`doc:${fields.id}`);
  if (fields.id !== undefined && !id)
    throw new Error(`${path}: id "${fields.id}" isn't a document id`);
  const version = fields.version === undefined ? null : Number(fields.version);
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    throw new Error(
      `${path}: version "${fields.version}" isn't a positive integer`,
    );
  }
  return {
    path,
    raw,
    id,
    version,
    hash: fields.hash ?? null,
    title: fields.title ?? posix.basename(path).replace(/\.md$/i, ""),
    project: fields.project?.toUpperCase() ?? null,
    task: fields.task?.toUpperCase() ?? null,
    body,
  };
}

/** What `readSourceFolder` found: the files to publish, those that can't be, and what it skipped. */
export interface SourceFolder {
  docs: SourceDoc[];
  /** Files that are reported as `failed` and never written: too large, or not UTF-8. */
  failed: PublishResult[];
  /**
   * Files skipped with a reason (symbolic links, paths that lead outside the folder), and files
   * whose front matter holds no key publish reads.
   */
  warnings: string[];
}

/**
 * Reads the `.md` files under `root` (relative paths with `/`; hidden files and folders and
 * `node_modules` aren't documents). Symbolic links and files that resolve outside the folder are
 * skipped, since publish would write into them. Throws, like `parseSourceDoc`, for a bad `id` or
 * `version`.
 */
export async function readSourceFolder(root: string): Promise<SourceFolder> {
  const realRoot = await realpath(root);
  const paths = (await readdir(root, { recursive: true }))
    .map((p) => p.split("\\").join("/"))
    .filter(
      (p) =>
        /\.md$/i.test(p) &&
        !p
          .split("/")
          .some((part) => part.startsWith(".") || part === "node_modules"),
    )
    .sort();
  const folder: SourceFolder = { docs: [], failed: [], warnings: [] };
  const fail = (path: string, message: string) =>
    folder.failed.push({
      file: path,
      status: "failed",
      id: null,
      title: posix.basename(path).replace(/\.md$/i, ""),
      version: null,
      message,
    });
  for (const path of paths) {
    const file = join(root, path);
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      folder.warnings.push(`${path} is a symbolic link; skipped`);
      continue;
    }
    if (!info.isFile()) continue;
    // A symbolic link to a folder on the way leads outside `root`.
    const inside = relative(realRoot, await realpath(file));
    if (inside.startsWith("..") || isAbsolute(inside)) {
      folder.warnings.push(
        `${path} is outside the folder (through a symbolic link); skipped`,
      );
      continue;
    }
    if (info.size > MAX_DOCUMENT_BYTES) {
      fail(
        path,
        `${Math.ceil(info.size / 1000)} KB is more than a document can hold (1 MB); not published`,
      );
      continue;
    }
    const raw = decodeUtf8(await readFile(file));
    if (raw === null) {
      fail(
        path,
        "Not UTF-8 text; not published, and the file wasn't changed. Save it as UTF-8 and publish again",
      );
      continue;
    }
    folder.docs.push(parseSourceDoc(path, raw));
    if (frontMatterWithoutKnownKeys(raw))
      folder.warnings.push(
        `${path} opens with a front matter block (between --- lines) holding none of the keys publish reads (${FRONT_MATTER_KEYS.join(", ")}); its text isn't part of the document`,
      );
  }
  return folder;
}

/** What `resolveLinks` made of a file's links. */
export interface ResolvedContent {
  content: string;
  /** Links to files of the folder that have no document yet: left as written for now. */
  pending: string[];
  /** Links that can't be resolved inside the folder and were left as written. */
  warnings: string[];
}

/** The files a link can lead to, by path and by title (or file name, Obsidian style). */
export interface LinkIndex {
  byPath: Map<string, SourceDoc>;
  byTitle: Map<string, SourceDoc[]>;
}

export function linkIndex(docs: readonly SourceDoc[]): LinkIndex {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const byTitle = new Map<string, SourceDoc[]>();
  const add = (key: string, doc: SourceDoc) => {
    const list = byTitle.get(key) ?? [];
    if (!list.includes(doc)) list.push(doc);
    byTitle.set(key, list);
  };
  for (const doc of docs) add(normalizeTitle(doc.title), doc);
  // File names count after titles: a title match wins.
  for (const doc of docs) {
    const stem = normalizeTitle(posix.basename(doc.path).replace(/\.md$/i, ""));
    if (!byTitle.has(stem)) add(stem, doc);
  }
  return { byPath, byTitle };
}

/** `[text](path.md)`, `[text](path.md#heading)` or `[text](<path with spaces.md>)`; not images. */
const MARKDOWN_LINK =
  /(!?)\[([^[\]\n]*)\]\(\s*(<[^<>\n]+>|[^()\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * `doc.body` with links to the folder's files as `[[doc:<id>]]` links (ST-115), which survive
 * renames: `[[Title]]` (a file's title, or its name without `.md`) and relative `.md` links.
 * A `#heading` and a label carry over; a Markdown link's text becomes the label. Links in code,
 * to tasks, by id, and to titles outside the folder stay as written. `idOf` gives a file's
 * document id, null while it has none yet, or false when it has none and won't get one in this
 * publish (its document is gone, or it failed): links to it stay as written, with a warning.
 */
export function resolveLinks(
  doc: SourceDoc,
  index: LinkIndex,
  idOf: (doc: SourceDoc) => string | null | false,
): ResolvedContent {
  const text = doc.body;
  const masked = maskCode(text);
  const pending: string[] = [];
  const warnings: string[] = [];
  const edits: { start: number; end: number; with: string }[] = [];

  const target = (to: SourceDoc): string | null => {
    const id = idOf(to);
    if (id) return documentIdLink(id);
    if (id === false) {
      const warning = `links to ${to.path} stay as written: it has no document`;
      if (!warnings.includes(warning)) warnings.push(warning);
    } else if (!pending.includes(to.path)) pending.push(to.path);
    return null;
  };

  for (const match of masked.matchAll(WIKI_LINK)) {
    const start = match.index;
    const end = start + match[0].length;
    // Masked code keeps offsets, so the link reads the same in the text.
    const inner = text.slice(start + 2, start + 2 + (match[1] ?? "").length);
    const hash = inner.indexOf("#");
    const name = hash < 0 ? inner : inner.slice(0, hash);
    if (!name.trim() || taskKeyTarget(name) || documentIdTarget(name)) continue;
    const found = index.byTitle.get(normalizeTitle(name));
    if (!found?.length) continue;
    if (found.length > 1) {
      warnings.push(
        `[[${name.trim()}]] matches ${found.map((d) => d.path).join(", ")}; linked to ${found[0]?.path}`,
      );
    }
    const to = found[0];
    const link = to && target(to);
    if (!link) continue;
    // What follows the name as written: `#heading`, then `|label]]` or `]]`.
    edits.push({
      start,
      end,
      with: `[[${link}${text.slice(start + 2 + name.length, end)}`,
    });
  }

  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    if (match[1]) continue;
    const href = (match[3] ?? "").replace(/^<|>$/g, "");
    // Absolute URLs (any scheme), site-absolute paths and in-page anchors aren't files of the folder.
    if (
      /^[a-z][a-z\d+.-]*:/i.test(href) ||
      href.startsWith("/") ||
      href.startsWith("#")
    )
      continue;
    const hash = href.indexOf("#");
    const file = hash < 0 ? href : href.slice(0, hash);
    if (!/\.md$/i.test(file)) continue;
    let decoded = file;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      // Keep the path as written.
    }
    const path = posix.normalize(posix.join(posix.dirname(doc.path), decoded));
    const to = index.byPath.get(path);
    if (!to) {
      warnings.push(`${href} isn't a file of the folder; left as written`);
      continue;
    }
    const link = target(to);
    if (!link) continue;
    const start = match.index;
    const end = start + match[0].length;
    const heading = hash < 0 ? "" : href.slice(hash);
    const label = (
      /^\[([^[\]\n]*)\]/.exec(text.slice(start, end))?.[1] ?? ""
    ).trim();
    edits.push({
      start,
      end,
      with: `[[${link}${heading}${label ? `|${label}` : ""}]]`,
    });
  }

  edits.sort((a, b) => a.start - b.start);
  let content = "";
  let last = 0;
  for (const edit of edits) {
    if (edit.start < last) continue;
    content += text.slice(last, edit.start) + edit.with;
    last = edit.end;
  }
  return { content: content + text.slice(last), pending, warnings };
}

/** What happened to one file; in a dry run, what would. */
export type PublishStatus =
  "created" | "updated" | "unchanged" | "conflict" | "failed";

export interface PublishResult {
  /** Relative to the folder. */
  file: string;
  status: PublishStatus;
  /** Null for a file that has no document (yet). */
  id: string | null;
  title: string;
  /** The document's version after the publish (in a dry run, the current one). */
  version: number | null;
  url?: string;
  /** Why a file is a conflict or failed. */
  message?: string;
  /**
   * `unchanged` only: the file is as last published but the document has newer versions in the
   * tracker (ST-132). Nothing is saved; `version` is the tracker's.
   */
  trackerNewer?: boolean;
  /** Links left as written. */
  warnings?: string[];
}

export interface PublishResponse {
  dryRun: boolean;
  results: PublishResult[];
  /** Files skipped before publishing (symbolic links, paths outside the folder), and front matter without known keys. */
  warnings: string[];
  summary: Record<PublishStatus, number>;
}

export interface PublishOptions {
  client: SpiderClient;
  org: string;
  docs: SourceDoc[];
  /** Files that can't be published (from `readSourceFolder`): reported as they are. */
  failed?: PublishResult[];
  /** Files skipped before publishing, and other notes on the files, reported with the results. */
  warnings?: string[];
  /** For files whose front matter names no `project` or `task`. */
  project?: string;
  dryRun: boolean;
  /** Saves a file's new text (its front matter with `id` and `version`). */
  save: (doc: SourceDoc, raw: string) => Promise<void>;
}

const apiMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const isConflict = (err: unknown) =>
  err instanceof SpiderApiError && err.status === 409;

/** How many documents are read from the API at a time. */
const READ_CONCURRENCY = 8;

/** Runs `fn` on every item, at most `limit` at a time. */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Publishes the files in three steps: reads the documents the files already have, creates the
 * missing ones (writing their `id` and `version` back right away), then saves the content, with
 * every link to a file of the folder as `[[doc:<id>]]`. An update is based on the file's `version`:
 * when the document changed since, the file is a conflict and nothing is overwritten.
 */
export async function publishDocuments(
  options: PublishOptions,
): Promise<PublishResponse> {
  const { client, org, docs, dryRun } = options;
  const index = linkIndex(docs);
  const ids = new Map<SourceDoc, string>();
  for (const doc of docs) if (doc.id) ids.set(doc, doc.id);
  // Files without a document that won't get one in this run: links to them stay as written.
  const dead = new Set<SourceDoc>();
  const idOf = (doc: SourceDoc) =>
    dead.has(doc) ? false : (ids.get(doc) ?? null);
  const results = new Map<SourceDoc, PublishResult>();
  const base = (doc: SourceDoc): PublishResult => ({
    file: doc.path,
    status: "unchanged",
    id: doc.id,
    title: doc.title,
    version: doc.version,
  });

  // The files' front matter, kept current as `id` and `version` are written back. Returns why the
  // file couldn't be written, or null; the document is saved either way.
  const record = async (
    doc: SourceDoc,
    saved: DocumentDto,
  ): Promise<string | null> => {
    const updates: Record<string, string> = {};
    const hash = sourceHash(doc);
    if (doc.id !== saved.id) updates.id = saved.id;
    if (doc.version !== saved.version) updates.version = String(saved.version);
    if (doc.hash !== hash) updates.hash = hash;
    if (!Object.keys(updates).length) return null;
    const raw = setFrontMatter(doc.raw, updates);
    try {
      await options.save(doc, raw);
    } catch (err) {
      return `Saved as ${saved.id} v${saved.version}, but the file couldn't be written (${apiMessage(err)}): add "id: ${saved.id}" and "version: ${saved.version}" to its front matter before publishing again`;
    }
    doc.raw = raw;
    doc.id = saved.id;
    doc.version = saved.version;
    doc.hash = hash;
    return null;
  };

  // 1. The documents the files already have, a few requests at a time.
  const current = new Map<SourceDoc, DocumentDto>();
  await forEachLimit(
    docs.filter((doc) => doc.id),
    READ_CONCURRENCY,
    async (doc) => {
      try {
        current.set(doc, await client.documents.get(org, doc.id ?? ""));
      } catch (err) {
        const missing = err instanceof SpiderApiError && err.status === 404;
        if (missing) {
          ids.delete(doc);
          dead.add(doc);
        }
        results.set(doc, {
          ...base(doc),
          status: "failed",
          message: missing
            ? `No document ${doc.id} (deleted, or not visible to you); remove id and version from the front matter to create it again`
            : apiMessage(err),
        });
      }
    },
  );

  // 2. New documents, with the links that can be resolved so far.
  const unfinished: { doc: SourceDoc; content: string }[] = [];
  for (const doc of docs.filter((d) => !d.id)) {
    const scope = doc.task
      ? { task: doc.task }
      : (doc.project ?? options.project)
        ? { project: doc.project ?? options.project }
        : {};
    if (dryRun) {
      results.set(doc, { ...base(doc), status: "created" });
      continue;
    }
    const resolved = resolveLinks(doc, index, idOf);
    let created: DocumentDto;
    try {
      created = await client.documents.create(org, {
        title: doc.title,
        format: "md",
        content: resolved.content,
        ...scope,
      });
    } catch (err) {
      dead.add(doc);
      results.set(doc, {
        ...base(doc),
        status: "failed",
        message: apiMessage(err),
      });
      continue;
    }
    ids.set(doc, created.id);
    const unrecorded = await record(doc, created);
    results.set(doc, {
      ...base(doc),
      status: "created",
      id: created.id,
      version: created.version,
      url: created.url,
      ...(unrecorded ? { message: unrecorded } : {}),
    });
    // Without its id in the file, a second save would be based on nothing: links wait for a rerun.
    if (resolved.pending.length && !unrecorded)
      unfinished.push({ doc, content: resolved.content });
  }

  // 3. Content: links to the new documents for those created in step 2, then the existing ones.
  for (const { doc, content } of unfinished) {
    const resolved = resolveLinks(doc, index, idOf);
    const result = results.get(doc);
    if (
      !result ||
      doc.version === null ||
      !doc.id ||
      resolved.content === content
    )
      continue;
    try {
      const saved = await client.documents.update(org, doc.id, {
        baseVersion: doc.version,
        content: resolved.content,
      });
      result.version = saved.version;
      const unrecorded = await record(doc, saved);
      if (unrecorded) result.message = unrecorded;
    } catch (err) {
      result.message = `Created, but its links weren't saved: ${apiMessage(err)}`;
      result.status = isConflict(err) ? "conflict" : "failed";
    }
  }

  for (const doc of docs) {
    const remote = current.get(doc);
    if (!remote || !doc.id) continue;
    const resolved = resolveLinks(doc, index, idOf);
    const result: PublishResult = {
      ...base(doc),
      version: remote.version,
      url: remote.url,
    };
    results.set(doc, result);
    const same =
      !resolved.pending.length &&
      remote.content === resolved.content &&
      remote.title === doc.title.trim() &&
      remote.format === "md";
    if (same) {
      // Up to date; a version saved since with the same text is taken as the file's base from now on.
      if (!dryRun) {
        const unrecorded = await record(doc, remote);
        if (unrecorded) result.message = unrecorded;
      }
      continue;
    }
    // The file is as last published and only the tracker moved on: nothing to publish (ST-132).
    if (
      doc.version !== null &&
      doc.version < remote.version &&
      doc.hash === sourceHash(doc)
    ) {
      result.trackerNewer = true;
      result.message = `The tracker has newer versions (${doc.version} → ${remote.version}) and this file hasn't changed since it was published: to update the file, copy the document's content (spider doc view ${doc.id} --json | jq -r .content) and set version: ${remote.version}`;
      continue;
    }
    if (doc.version === null || doc.version !== remote.version) {
      result.status = "conflict";
      result.message =
        doc.version === null
          ? `No version in the front matter: add the version this file is based on (now ${remote.version}; see spider doc view ${doc.id}) to publish it`
          : `Changed in the tracker since version ${doc.version} (now ${remote.version}): merge those changes into the file (spider doc diff ${doc.id} --from ${doc.version}), set version: ${remote.version} and publish again`;
      continue;
    }
    result.status = "updated";
    if (dryRun) continue;
    let saved: DocumentDto;
    try {
      saved = await client.documents.update(org, doc.id, {
        baseVersion: doc.version,
        title: doc.title,
        format: "md",
        content: resolved.content,
      });
    } catch (err) {
      result.status = isConflict(err) ? "conflict" : "failed";
      result.message = apiMessage(err);
      continue;
    }
    result.version = saved.version;
    result.url = saved.url;
    const unrecorded = await record(doc, saved);
    if (unrecorded) result.message = unrecorded;
  }

  // Warnings, from the final resolution (a dry run's new documents have no id: their links count as resolved).
  const ordered = docs.map((doc) => {
    const result = results.get(doc) ?? base(doc);
    const placeholder = (d: SourceDoc) =>
      dead.has(d)
        ? false
        : (ids.get(d) ?? "00000000-0000-7000-8000-000000000000");
    const { warnings } = resolveLinks(doc, index, placeholder);
    return warnings.length ? { ...result, warnings } : result;
  });
  const all = [...ordered, ...(options.failed ?? [])].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  const summary: Record<PublishStatus, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    failed: 0,
  };
  for (const r of all) summary[r.status] += 1;
  return { dryRun, results: all, warnings: options.warnings ?? [], summary };
}

/** The report, one line per file (and its warnings), then the counts. */
export function publishLines({
  dryRun,
  results,
  warnings,
  summary,
}: PublishResponse): string {
  const skipped = warnings.map((w) => `warning: ${w}`);
  if (!results.length)
    return [...skipped, "No .md files to publish"].join("\n");
  const label = ({ status, trackerNewer }: PublishResult) =>
    dryRun && (status === "created" || status === "updated")
      ? `would ${status === "created" ? "create" : "update"}`
      : trackerNewer
        ? `${status} (tracker newer)`
        : status;
  const labelWidth = Math.max(...results.map((r) => label(r).length));
  const fileWidth = Math.max(...results.map((r) => r.file.length));
  const lines: string[] = [...skipped];
  for (const r of results) {
    const where = r.id
      ? `  (${r.id}${r.version ? `, v${r.version}` : ""})`
      : "";
    lines.push(
      `${label(r).padEnd(labelWidth)}  ${r.file.padEnd(fileWidth)}  ${r.title}${where}`,
    );
    if (r.message) lines.push(`  ${r.message}`);
    for (const w of r.warnings ?? []) lines.push(`  warning: ${w}`);
  }
  const counts = [
    `${summary.created} ${dryRun ? "to create" : "created"}`,
    `${summary.updated} ${dryRun ? "to update" : "updated"}`,
    `${summary.unchanged} unchanged`,
    `${summary.conflict} conflict${summary.conflict === 1 ? "" : "s"}`,
    `${summary.failed} failed`,
  ].join(", ");
  lines.push(dryRun ? `Dry run: ${counts}; nothing was changed.` : counts);
  return lines.join("\n");
}
