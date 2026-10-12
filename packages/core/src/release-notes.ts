// Release changelogs (ST-95). Browser-safe (no database): the API builds a release's changelog from
// its included tasks, the CLI regroups it by app from local git and writes CHANGELOG.md sections,
// and the web app can preview it.
//
// - An entry is a task's title plus the "What changed" section of its handoff note (`findHandoff`).
// - The changelog lives in the release's description between markers that carry a hash of what
//   was generated, so a hand edit is noticed and never overwritten without `force`.
import type { AppVersioning, ChangelogState, ReleaseChangelogDto, ReleaseChangelogEntryDto } from "./contracts";

// ---------------------------------------------------------------------------------------------
// Handoff notes

/** A Markdown heading: "## What changed". */
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
/** A line opening with a bold label: "**Verified**", "**What changed:**", "**Open**: …". */
const BOLD_LABEL = /^ {0,3}(?:\*\*|__)([^*_\n]{1,80}?)\s*:?\s*(?:\*\*|__)\s*:?\s*(.*)$/;
/** A line that is only a label and a colon: "What changed:", "Verified:". */
const PLAIN_LABEL = /^ {0,3}([A-Za-z][\w ()/'-]{0,60}?)\s*:\s*(.*)$/;
const WHAT_CHANGED = /^what\s+changed\b/i;

/** A heading or label that opens a section of a note, with any text after it on the same line. */
function sectionLabel(line: string): { label: string; rest: string; plain: boolean } | null {
  const heading = HEADING.exec(line);
  if (heading) return { label: (heading[1] ?? "").replace(/:$/, ""), rest: "", plain: false };
  const bold = BOLD_LABEL.exec(line);
  if (bold) return { label: bold[1] ?? "", rest: bold[2] ?? "", plain: false };
  const plain = PLAIN_LABEL.exec(line);
  // A plain "Label:" counts only alone on its line, so prose with a colon doesn't end a section.
  if (plain && !(plain[2] ?? "").trim()) return { label: plain[1] ?? "", rest: "", plain: true };
  if (plain && WHAT_CHANGED.test(plain[1] ?? "")) return { label: plain[1] ?? "", rest: plain[2] ?? "", plain: true };
  return null;
}

/**
 * The "What changed" section of a handoff note, or null. The section starts at a heading
 * ("## What changed"), a bold label ("**What changed**", "**What changed:** text") or a plain
 * "What changed:" line, and runs to the next heading, bold label or "Label:" line on its own.
 */
export function whatChangedIn(body: string): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  let first = "";
  for (let i = 0; i < lines.length; i++) {
    const found = sectionLabel(lines[i] ?? "");
    if (found && WHAT_CHANGED.test(found.label.trim())) {
      start = i + 1;
      first = found.rest.trim();
      break;
    }
  }
  if (start < 0) return null;
  const section: string[] = first ? [first] : [];
  let fence = false;
  for (const line of lines.slice(start)) {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    if (!fence && sectionLabel(line)) break;
    section.push(line);
  }
  const text = section.join("\n").replace(/^\s*\n/, "").trimEnd();
  return text.trim() ? dedent(text) : null;
}

/** Removes the indentation every non-blank line shares. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const common = indents.length ? Math.min(...indents) : 0;
  return common ? lines.map((l) => l.slice(common)).join("\n") : text;
}

export interface HandoffComment {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

/**
 * A task's handoff note: the latest comment with a "What changed" section by one of the task's
 * assignees, else the latest such comment by anyone (the work may have been reassigned since).
 */
export function findHandoff(
  comments: HandoffComment[],
  assigneeIds: string[],
): { comment: HandoffComment; whatChanged: string } | null {
  const newest = [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const assignees = new Set(assigneeIds);
  const withSection = (list: HandoffComment[]) => {
    for (const comment of list) {
      const whatChanged = whatChangedIn(comment.body);
      if (whatChanged) return { comment, whatChanged };
    }
    return null;
  };
  return withSection(newest.filter((c) => assignees.has(c.authorId))) ?? withSection(newest);
}

// ---------------------------------------------------------------------------------------------
// Tags and versions

/** An app's git tag for a version: "web-2026.10.13" (date), "cli-v0.1.8" (semver). */
export function releaseTag(app: { name: string; versioning: AppVersioning }, version: string): string {
  return app.versioning === "semver" ? `${app.name}-v${version}` : `${app.name}-${version}`;
}

/** The version in one of the app's tags ("cli-v0.1.8" → "0.1.8"), or null for another app's tag. */
export function versionOfTag(app: { name: string; versioning: AppVersioning }, tag: string): string | null {
  const prefix = app.versioning === "semver" ? `${app.name}-v` : `${app.name}-`;
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  const pattern =
    app.versioning === "semver" ? /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/ : /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/;
  return pattern.test(version) ? version : null;
}

/** Orders two versions of the same versioning: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split("+")[0]?.split(/-(.*)/s) ?? [];
  const [coreB = "", preB] = b.split("+")[0]?.split(/-(.*)/s) ?? [];
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff) return diff;
  }
  // 1.0.0-rc.1 comes before 1.0.0.
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return (preA ?? "").localeCompare(preB ?? "", undefined, { numeric: true });
}

/** The app's newest tag older than `version` (any version when null), or null. */
export function previousTag(app: { name: string; versioning: AppVersioning }, tags: string[], version: string | null): string | null {
  let best: { tag: string; version: string } | null = null;
  for (const tag of tags) {
    const v = versionOfTag(app, tag.trim());
    if (!v || (version !== null && compareVersions(v, version) >= 0)) continue;
    if (!best || compareVersions(v, best.version) > 0) best = { tag: tag.trim(), version: v };
  }
  return best?.tag ?? null;
}

// ---------------------------------------------------------------------------------------------
// Rendering

type EntryInput = Pick<ReleaseChangelogEntryDto, "key" | "title" | "whatChanged" | "apps">;

/** Headings inside a note would split the changelog's app sections: they become bold lines. */
const flattenHeadings = (text: string) => text.replace(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, "**$1**");

function entryLines(entry: EntryInput): string {
  const head = `- **${entry.key}** ${entry.title.trim()}`;
  if (!entry.whatChanged) return head;
  const body = flattenHeadings(entry.whatChanged)
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : ""))
    .join("\n");
  return `${head}\n${body}`;
}

const list = (entries: EntryInput[]) => entries.map(entryLines).join("\n");

/**
 * The changelog in Markdown. Grouped: a `### <app> <version>` section per app with the tasks that
 * touch it (a task can be in several), then "Other changes" for tasks that touch none of them.
 * Not grouped: one list, under "### Changes" when the release ships apps.
 */
export function renderChangelog(apps: { name: string; version: string }[], entries: EntryInput[], grouped: boolean): string {
  if (entries.length === 0) return "_No tasks in this release yet._";
  if (apps.length === 0) return list(entries);
  if (!grouped) return `### Changes\n\n${list(entries)}`;
  const names = new Set(apps.map((a) => a.name));
  const sections = apps.map((app) => {
    const own = entries.filter((e) => e.apps.includes(app.name));
    return `### ${app.name} ${app.version}\n\n${own.length ? list(own) : "_No tasks._"}`;
  });
  const other = entries.filter((e) => !e.apps.some((a) => names.has(a)));
  if (other.length) sections.push(`### Other changes\n\n${list(other)}`);
  return sections.join("\n\n");
}

/** The section of one app in a rendered changelog (without its heading), or null. */
export function appNotes(markdown: string, appName: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^###\\s+${escapeRegExp(appName)}(\\s|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------------------------
// The changelog block in a release's description

const BLOCK = /<!-- spider:changelog(?: hash=([0-9a-f]{8}))? -->\n?([\s\S]*?)\n?<!-- \/spider:changelog -->/;

/** FNV-1a: a short fingerprint of the generated text, to notice hand edits (not for security). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The changelog block of a description: its text and whether it was changed since it was written. */
export function changelogBlock(description: string | null | undefined): { content: string; edited: boolean } | null {
  const match = description ? BLOCK.exec(description) : null;
  if (!match) return null;
  const content = (match[2] ?? "").trim();
  return { content, edited: match[1] !== fingerprint(content) };
}

/** How the description's block compares with freshly generated `markdown`. */
export function changelogState(description: string | null | undefined, markdown: string): ChangelogState {
  const block = changelogBlock(description);
  if (!block) return "missing";
  if (block.edited) return "edited";
  return block.content === markdown.trim() ? "current" : "outdated";
}

/** The description with `markdown` as its changelog block: replaced in place, or appended. */
export function withChangelog(description: string | null | undefined, markdown: string): string {
  const content = markdown.trim();
  const block = `<!-- spider:changelog hash=${fingerprint(content)} -->\n${content}\n<!-- /spider:changelog -->`;
  const current = description ?? "";
  if (BLOCK.test(current)) return current.replace(BLOCK, () => block);
  return current.trim() ? `${current.trimEnd()}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------------------------
// Building and regrouping

/** Fills in `markdown` and `description` from the entries; entries' apps are kept as given. */
export function finishChangelog(
  base: Omit<ReleaseChangelogDto, "markdown" | "description" | "written">,
  description: string | null | undefined,
): ReleaseChangelogDto {
  const markdown = renderChangelog(base.apps, base.entries, base.grouped);
  return {
    ...base,
    markdown,
    description: { state: changelogState(description, markdown), content: changelogBlock(description)?.content ?? null },
    written: null,
  };
}

/**
 * The changelog grouped with `taskApps` (task key → app names, e.g. from local git): each entry
 * keeps the names of the release's apps it touches. The description state is recomputed from the
 * block's content (an edited block stays edited).
 */
export function regroupChangelog(changelog: ReleaseChangelogDto, taskApps: Record<string, string[]>): ReleaseChangelogDto {
  const names = new Set(changelog.apps.map((a) => a.name));
  const entries = changelog.entries.map((e) => ({ ...e, apps: [...new Set(taskApps[e.key] ?? [])].filter((a) => names.has(a)).sort() }));
  const markdown = renderChangelog(changelog.apps, entries, true);
  const { content, state } = changelog.description;
  const nextState: ChangelogState = content === null ? "missing" : state === "edited" ? "edited" : content === markdown.trim() ? "current" : "outdated";
  return { ...changelog, grouped: true, entries, markdown, description: { state: nextState, content } };
}

// ---------------------------------------------------------------------------------------------
// CHANGELOG.md

const releaseMarker = (key: string) => `<!-- spider:release ${key} -->`;

/** A release's section for CHANGELOG.md: "## <name> (<key>, <date>)" and its notes. */
export function changelogFileSection(release: { key: string; title: string }, date: string, notes: string): string {
  return `## ${release.title} (${release.key}, ${date})\n${releaseMarker(release.key)}\n\n${notes.trim()}\n`;
}

/**
 * CHANGELOG.md with a release's section inserted after the "Unreleased" section (else before the
 * first `## ` section, else at the end). Unchanged when the release is in it already.
 */
export function insertReleaseSection(file: string, release: { key: string }, section: string): { text: string; inserted: boolean } {
  if (file.includes(releaseMarker(release.key))) return { text: file, inserted: false };
  const lines = file.split("\n");
  const unreleased = lines.findIndex((l) => /^##\s+unreleased\b/i.test(l));
  const nextSection = (from: number) => lines.findIndex((l, i) => i > from && /^##\s/.test(l));
  const at = unreleased >= 0 ? nextSection(unreleased) : nextSection(-1);
  if (at < 0) {
    const body = file.trimEnd();
    return { text: `${body ? `${body}\n\n` : ""}${section}`, inserted: true };
  }
  const before = lines.slice(0, at).join("\n").trimEnd();
  const after = lines.slice(at).join("\n");
  return { text: `${before}\n\n${section}\n${after}`, inserted: true };
}
