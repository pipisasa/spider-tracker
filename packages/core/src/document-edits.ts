// Partial document edits (ST-116): replace a fragment, append, or replace a Markdown section.
// Browser-safe (no database). Edits apply in order; the first one that can't apply throws, so
// a batch either applies whole or not at all.
import type { DocumentFormat } from "./contracts";
import { DomainError } from "./errors";
import type { DocumentEdit } from "./schemas";

/** A Markdown ATX heading: its level, text and where its line starts and ends (after the line break). */
export interface MarkdownHeading {
  level: number;
  text: string;
  start: number;
  end: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Heading text as matched: closing #s dropped, whitespace collapsed. */
function headingText(raw: string): string {
  return raw
    .replace(/(?:^|[ \t]+)#+$/, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** The ATX headings (`# …` to `###### …`) of Markdown text, fenced code excluded. */
export function markdownHeadings(content: string): MarkdownHeading[] {
  return scanMarkdown(content).headings;
}

/** The headings of Markdown text, and whether a code fence is still open at its end. */
function scanMarkdown(content: string): {
  headings: MarkdownHeading[];
  openFence: boolean;
} {
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  let start = 0;
  for (const rawLine of content.split("\n")) {
    const end = Math.min(start + rawLine.length + 1, content.length);
    const line = rawLine.replace(/\r$/, "");
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      const marker = fenceMatch?.[1];
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !fenceMatch[2]?.trim()
      )
        fence = null;
    } else if (
      fenceMatch?.[1] &&
      !(fenceMatch[1][0] === "`" && fenceMatch[2]?.includes("`"))
    ) {
      fence = fenceMatch[1];
    } else {
      const match = ATX.exec(line);
      if (match?.[1])
        headings.push({
          level: match[1].length,
          text: headingText(match[2] ?? ""),
          start,
          end,
        });
    }
    start = end;
  }
  return { headings, openFence: fence !== null };
}

/** `"## Decisions"` names a level-2 heading; plain `"Decisions"` one of any level. */
function parseSection(section: string): { level: number | null; text: string } {
  const match = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(section.trim());
  if (match?.[1])
    return { level: match[1].length, text: headingText(match[2] ?? "") };
  return { level: null, text: headingText(section) };
}

const preview = (text: string) =>
  JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);

function occurrences(content: string, fragment: string): number {
  let count = 0;
  for (
    let at = content.indexOf(fragment);
    at !== -1;
    at = content.indexOf(fragment, at + fragment.length)
  )
    count++;
  return count;
}

function replaceFragment(
  content: string,
  edit: { old: string; new: string; all?: boolean },
): string {
  if (!edit.old)
    throw new DomainError(
      "validation",
      "old: the fragment to replace can't be empty",
    );
  const count = occurrences(content, edit.old);
  if (count === 0) {
    throw new DomainError(
      "conflict",
      `The document doesn't contain ${preview(edit.old)}. Read it again and edit the text that is there now`,
    );
  }
  if (edit.all) return content.split(edit.old).join(edit.new);
  if (count > 1) {
    throw new DomainError(
      "validation",
      `${preview(edit.old)} occurs ${count} times. Include more of the surrounding text to make it unique, or pass all to replace every occurrence`,
    );
  }
  const at = content.indexOf(edit.old);
  return content.slice(0, at) + edit.new + content.slice(at + edit.old.length);
}

/** Appends on a new line. */
function append(content: string, text: string): string {
  if (!text)
    throw new DomainError(
      "validation",
      "append: the text to append can't be empty",
    );
  if (!content || content.endsWith("\n")) return content + text;
  return `${content}\n${text}`;
}

/**
 * Replaces the body under a heading, up to the next heading of the same or a higher level; the
 * heading stays. The body takes the document's line endings (CRLF when the document uses them),
 * and may not contain a heading of the section's level or higher: that would end the section
 * early and split it in two. Nor may it leave a code fence open, which would swallow what follows.
 */
function replaceSection(
  content: string,
  format: DocumentFormat,
  section: string,
  body: string,
): string {
  if (format !== "md")
    throw new DomainError(
      "validation",
      "Section edits work on Markdown documents only",
    );
  const target = parseSection(section);
  if (!target.text)
    throw new DomainError(
      "validation",
      'section: name a heading, e.g. "## Decisions"',
    );
  const headings = markdownHeadings(content);
  const matches = headings.filter(
    (h) =>
      h.text === target.text &&
      (target.level === null || h.level === target.level),
  );
  if (matches.length === 0) {
    throw new DomainError(
      "conflict",
      `The document has no section ${preview(section.trim())}. Read it again for its current headings`,
    );
  }
  if (matches.length > 1) {
    throw new DomainError(
      "validation",
      `${matches.length} sections are headed ${preview(section.trim())}${target.level === null ? '. Name the level too, e.g. "## Decisions"' : ""}. Edit the right one with { old, new } instead`,
    );
  }
  const [heading] = matches as [MarkdownHeading];
  const next = headings.find(
    (h) => h.start > heading.start && h.level <= heading.level,
  );
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const before = content.slice(0, heading.end);
  const rest = next ? content.slice(next.start) : "";

  // A body that repeats the section's own heading doesn't add a second one.
  let text = body.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "");
  const [first] = markdownHeadings(text);
  if (
    first?.start === 0 &&
    first.level === heading.level &&
    first.text === heading.text
  ) {
    text = text.slice(first.end);
  }
  text = text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  const scanned = scanMarkdown(text);
  // An unclosed fence would turn the rest of the document, its headings included, into code.
  if (scanned.openFence)
    throw new DomainError(
      "validation",
      `The new body of ${preview(section.trim())} leaves a code fence open. Close it with a matching \`\`\` or ~~~ line`,
    );
  const breaking = scanned.headings.find((h) => h.level <= heading.level);
  if (breaking) {
    throw new DomainError(
      "validation",
      `The new body of ${preview(section.trim())} contains the heading ${preview(`${"#".repeat(breaking.level)} ${breaking.text}`)}, which would end the section. Use a lower-level heading, or edit the document with { old, new }`,
    );
  }
  if (eol !== "\n") text = text.replace(/\n/g, eol);

  return `${before.endsWith("\n") ? before : `${before}${eol}`}${text ? `${eol}${text}${eol}` : ""}${rest ? `${eol}${rest}` : ""}`;
}

/**
 * The content after applying `edits` in order. Throws `conflict` when a fragment or section isn't
 * there (the document may have changed) and `validation` when one is ambiguous or an edit is invalid.
 */
export function applyDocumentEdits(
  content: string,
  format: DocumentFormat,
  edits: DocumentEdit[],
): string {
  return edits.reduce((text, edit, index) => {
    try {
      if ("old" in edit) return replaceFragment(text, edit);
      if ("append" in edit) return append(text, edit.append);
      return replaceSection(text, format, edit.section, edit.content);
    } catch (err) {
      if (err instanceof DomainError && edits.length > 1) {
        throw new DomainError(err.code, `Edit ${index + 1}: ${err.message}`);
      }
      throw err;
    }
  }, content);
}
