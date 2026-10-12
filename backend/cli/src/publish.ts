// `spider doc publish <dir>` (ST-119): a folder of Markdown files published as documents, with
// links between the files turned into tracker links. Parsing, front matter and link resolution
// are pure functions; `publishDocuments` drives the API through the SDK.
import type { DocumentDto } from "@repo/core/contracts";
import { WIKI_LINK, documentIdLink, documentIdTarget, maskCode, normalizeTitle, taskKeyTarget } from "@repo/core/links";
import { SpiderApiError, type SpiderClient } from "@repo/sdk";
import { posix } from "node:path";

/** The front matter keys publish reads; `id` and `version` are written back after a publish. */
export interface FrontMatter {
  id?: string;
  version?: string;
  title?: string;
  project?: string;
  task?: string;
}

const FRONT_MATTER_KEYS = ["id", "version", "title", "project", "task"] as const;

/** `---` on the first line, `key: value` lines, then `---` (or `...`) on a line of its own. */
const FRONT_MATTER = /^---[^\S\n]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[^\S\n]*(?:\r?\n|$)/m;

/** A value without its quotes, or without a trailing ` # comment` when unquoted. */
const unquote = (value: string) => {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v.replace(/(?:^|\s+)#.*$/, "");
};

/**
 * Splits a file into its front matter (the keys publish knows; other lines are kept as written
 * but not read) and the document's content, without the blank lines after the front matter.
 */
export function parseFrontMatter(raw: string): { fields: FrontMatter; body: string } {
  const match = raw.startsWith("---") ? FRONT_MATTER.exec(raw) : null;
  if (!match || match.index !== 0) return { fields: {}, body: raw };
  const fields: FrontMatter = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? "").toLowerCase();
    const value = unquote(kv[2] ?? "");
    const known = FRONT_MATTER_KEYS.find((k) => k === key);
    if (known && value !== "") fields[known] = value;
  }
  return { fields, body: raw.slice(match[0].length).replace(/^(?:[^\S\n]*\r?\n)+/, "") };
}

/**
 * `raw` with `updates` set in its front matter: an existing `key:` line is replaced, a missing key
 * is added at the end, and a file without front matter gets one. Everything else stays as written.
 */
export function setFrontMatter(raw: string, updates: Record<string, string>): string {
  const match = raw.startsWith("---") ? FRONT_MATTER.exec(raw) : null;
  const entries = Object.entries(updates);
  if (!match || match.index !== 0) {
    return `---\n${entries.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${raw}`;
  }
  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = (match[1] ?? "").split(/\r?\n/);
  // The block ends with a line break, so the last split element is "".
  if (lines.at(-1) === "") lines.pop();
  for (const [key, value] of entries) {
    const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`, "i").test(line));
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  // The opening line, the block (group 1), then the closing line.
  const head = match[0].slice(0, match[0].indexOf("\n") + 1);
  const closing = match[0].slice(head.length + (match[1] ?? "").length);
  const block = lines.length ? `${lines.join(eol)}${eol}` : "";
  return `${head}${block}${closing.endsWith("\n") ? closing : `${closing}${eol}`}${raw.slice(match[0].length)}`;
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
  /** `title:` from the front matter, or the file name without `.md`. */
  title: string;
  project: string | null;
  task: string | null;
  body: string;
}

/** Parses one file; throws a message for an `id` or `version` that can't be right. */
export function parseSourceDoc(path: string, raw: string): SourceDoc {
  const { fields, body } = parseFrontMatter(raw);
  const id = fields.id === undefined ? null : documentIdTarget(`doc:${fields.id}`);
  if (fields.id !== undefined && !id) throw new Error(`${path}: id "${fields.id}" isn't a document id`);
  const version = fields.version === undefined ? null : Number(fields.version);
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    throw new Error(`${path}: version "${fields.version}" isn't a positive integer`);
  }
  return {
    path,
    raw,
    id,
    version,
    title: fields.title ?? posix.basename(path).replace(/\.md$/i, ""),
    project: fields.project?.toUpperCase() ?? null,
    task: fields.task?.toUpperCase() ?? null,
    body,
  };
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
const MARKDOWN_LINK = /(!?)\[([^[\]\n]*)\]\(\s*(<[^<>\n]+>|[^()\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * `doc.body` with links to the folder's files as `[[doc:<id>]]` links (ST-115), which survive
 * renames: `[[Title]]` (a file's title, or its name without `.md`) and relative `.md` links.
 * A `#heading` and a label carry over; a Markdown link's text becomes the label. Links in code,
 * to tasks, by id, and to titles outside the folder stay as written. `idOf` gives a file's
 * document id, or null while it has none.
 */
export function resolveLinks(doc: SourceDoc, index: LinkIndex, idOf: (doc: SourceDoc) => string | null): ResolvedContent {
  const text = doc.body;
  const masked = maskCode(text);
  const pending: string[] = [];
  const warnings: string[] = [];
  const edits: { start: number; end: number; with: string }[] = [];

  const target = (to: SourceDoc): string | null => {
    const id = idOf(to);
    if (id) return documentIdLink(id);
    if (!pending.includes(to.path)) pending.push(to.path);
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
      warnings.push(`[[${name.trim()}]] matches ${found.map((d) => d.path).join(", ")}; linked to ${found[0]?.path}`);
    }
    const to = found[0];
    const link = to && target(to);
    if (!link) continue;
    // What follows the name as written: `#heading`, then `|label]]` or `]]`.
    edits.push({ start, end, with: `[[${link}${text.slice(start + 2 + name.length, end)}` });
  }

  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    if (match[1]) continue;
    const href = (match[3] ?? "").replace(/^<|>$/g, "");
    // Absolute URLs (any scheme), site-absolute paths and in-page anchors aren't files of the folder.
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) continue;
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
    const label = (/^\[([^[\]\n]*)\]/.exec(text.slice(start, end))?.[1] ?? "").trim();
    edits.push({ start, end, with: `[[${link}${heading}${label ? `|${label}` : ""}]]` });
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
export type PublishStatus = "created" | "updated" | "unchanged" | "conflict" | "failed";

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
  /** Links left as written. */
  warnings?: string[];
}

export interface PublishResponse {
  dryRun: boolean;
  results: PublishResult[];
  summary: Record<PublishStatus, number>;
}

export interface PublishOptions {
  client: SpiderClient;
  org: string;
  docs: SourceDoc[];
  /** For files whose front matter names no `project` or `task`. */
  project?: string;
  dryRun: boolean;
  /** Saves a file's new text (its front matter with `id` and `version`). */
  save: (doc: SourceDoc, raw: string) => Promise<void>;
}

const apiMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isConflict = (err: unknown) => err instanceof SpiderApiError && err.status === 409;

/**
 * Publishes the files in three steps: reads the documents the files already have, creates the
 * missing ones (writing their `id` and `version` back right away), then saves the content, with
 * every link to a file of the folder as `[[doc:<id>]]`. An update is based on the file's `version`:
 * when the document changed since, the file is a conflict and nothing is overwritten.
 */
export async function publishDocuments(options: PublishOptions): Promise<PublishResponse> {
  const { client, org, docs, dryRun } = options;
  const index = linkIndex(docs);
  const ids = new Map<SourceDoc, string>();
  for (const doc of docs) if (doc.id) ids.set(doc, doc.id);
  const results = new Map<SourceDoc, PublishResult>();
  const base = (doc: SourceDoc): PublishResult => ({ file: doc.path, status: "unchanged", id: doc.id, title: doc.title, version: doc.version });

  // The files' front matter, kept current as `id` and `version` are written back.
  const record = async (doc: SourceDoc, saved: DocumentDto) => {
    const updates: Record<string, string> = {};
    if (doc.id !== saved.id) updates.id = saved.id;
    if (doc.version !== saved.version) updates.version = String(saved.version);
    if (!Object.keys(updates).length) return;
    const raw = setFrontMatter(doc.raw, updates);
    await options.save(doc, raw);
    doc.raw = raw;
    doc.id = saved.id;
    doc.version = saved.version;
  };

  // 1. The documents the files already have.
  const current = new Map<SourceDoc, DocumentDto>();
  await Promise.all(
    docs
      .filter((doc) => doc.id)
      .map(async (doc) => {
        try {
          current.set(doc, await client.documents.get(org, doc.id ?? ""));
        } catch (err) {
          const missing = err instanceof SpiderApiError && err.status === 404;
          results.set(doc, {
            ...base(doc),
            status: "failed",
            message: missing
              ? `No document ${doc.id} (deleted, or not visible to you); remove id and version from the front matter to create it again`
              : apiMessage(err),
          });
        }
      }),
  );

  // 2. New documents, with the links that can be resolved so far.
  const unfinished: SourceDoc[] = [];
  for (const doc of docs.filter((d) => !d.id)) {
    const scope = doc.task ? { task: doc.task } : (doc.project ?? options.project) ? { project: doc.project ?? options.project } : {};
    if (dryRun) {
      results.set(doc, { ...base(doc), status: "created" });
      continue;
    }
    const resolved = resolveLinks(doc, index, (d) => ids.get(d) ?? null);
    try {
      const created = await client.documents.create(org, { title: doc.title, format: "md", content: resolved.content, ...scope });
      ids.set(doc, created.id);
      await record(doc, created);
      results.set(doc, { ...base(doc), status: "created", id: created.id, version: created.version, url: created.url });
      if (resolved.pending.length) unfinished.push(doc);
    } catch (err) {
      results.set(doc, { ...base(doc), status: "failed", message: apiMessage(err) });
    }
  }

  // 3. Content: links to the new documents for those created in step 2, then the existing ones.
  for (const doc of unfinished) {
    const resolved = resolveLinks(doc, index, (d) => ids.get(d) ?? null);
    const result = results.get(doc);
    if (!result || doc.version === null || !doc.id) continue;
    try {
      const saved = await client.documents.update(org, doc.id, { baseVersion: doc.version, content: resolved.content });
      await record(doc, saved);
      result.version = saved.version;
    } catch (err) {
      result.message = `Created, but its links weren't saved: ${apiMessage(err)}`;
      result.status = isConflict(err) ? "conflict" : "failed";
    }
  }

  for (const doc of docs) {
    const remote = current.get(doc);
    if (!remote || !doc.id) continue;
    const resolved = resolveLinks(doc, index, (d) => ids.get(d) ?? null);
    const result: PublishResult = { ...base(doc), version: remote.version, url: remote.url };
    results.set(doc, result);
    const same = !resolved.pending.length && remote.content === resolved.content && remote.title === doc.title.trim() && remote.format === "md";
    if (same) {
      // Up to date; a version saved since with the same text is taken as the file's base from now on.
      if (!dryRun) await record(doc, remote);
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
    try {
      const saved = await client.documents.update(org, doc.id, {
        baseVersion: doc.version,
        title: doc.title,
        format: "md",
        content: resolved.content,
      });
      await record(doc, saved);
      result.version = saved.version;
      result.url = saved.url;
    } catch (err) {
      result.status = isConflict(err) ? "conflict" : "failed";
      result.message = apiMessage(err);
    }
  }

  // Warnings, from the final resolution (a dry run's new documents have no id: their links count as resolved).
  const ordered = docs.map((doc) => {
    const result = results.get(doc) ?? base(doc);
    const { warnings } = resolveLinks(doc, index, (d) => ids.get(d) ?? "00000000-0000-7000-8000-000000000000");
    return warnings.length ? { ...result, warnings } : result;
  });
  const summary: Record<PublishStatus, number> = { created: 0, updated: 0, unchanged: 0, conflict: 0, failed: 0 };
  for (const r of ordered) summary[r.status] += 1;
  return { dryRun, results: ordered, summary };
}

/** The report, one line per file (and its warnings), then the counts. */
export function publishLines({ dryRun, results, summary }: PublishResponse): string {
  if (!results.length) return "No .md files to publish";
  const label = (status: PublishStatus) =>
    dryRun && (status === "created" || status === "updated") ? `would ${status === "created" ? "create" : "update"}` : status;
  const labelWidth = Math.max(...results.map((r) => label(r.status).length));
  const fileWidth = Math.max(...results.map((r) => r.file.length));
  const lines: string[] = [];
  for (const r of results) {
    const where = r.id ? `  (${r.id}${r.version ? `, v${r.version}` : ""})` : "";
    lines.push(`${label(r.status).padEnd(labelWidth)}  ${r.file.padEnd(fileWidth)}  ${r.title}${where}`);
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
