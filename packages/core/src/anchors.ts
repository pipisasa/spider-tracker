// Fragment anchors for document comments (ST-118). A comment quotes the text it is about as a
// reader sees it (selected in the rendered document, or copied from the source). The quote still
// "anchors" while that text occurs in the document; otherwise the comment is outdated. Matching
// compares letters and digits only, so Markdown or HTML markup, link targets, punctuation and
// whitespace between the words don't count: "the **new** plan" anchors "the new plan".
// Browser-safe: no database imports.

import type { DocumentFormat } from "./contracts";
import { maskCode } from "./links";

/**
 * The text an unlabelled `[[target]]` shows, when it isn't the target itself: a `[[doc:<id>]]`
 * shows the document's title (ST-115). Null keeps the target.
 */
export type WikiLabel = (target: string) => string | null;

// Named character references a reader sees as one character: Latin-1 (U+00A0 to U+00FF, accented
// letters included, which the skeleton keeps) and common typography. Others stay as written.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const ENTITIES: Record<string, string> = {
  ...Object.fromEntries(
    LATIN1.split(" ").map((name, i) => [name, String.fromCharCode(0xa0 + i)]),
  ),
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  trade: "™",
  euro: "€",
};

/** `&copy;`, `&#169;` and `&#xA9;` as the character they show (unknown names stay as written). */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z]+));/g,
    (whole, dec?: string, hex?: string, name?: string) => {
      if (name) return ENTITIES[name] ?? whole;
      const code = dec ? Number(dec) : parseInt(hex ?? "", 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/** Markdown outside code: links shown by their labels, `[[…]]` by what they show, tags dropped. */
function readableMarkdown(content: string, label: WikiLabel): string {
  return decodeEntities(
    content
      // ![alt](src) and [label](href): only the alt text and label show.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // [[target|label]] shows the label; [[target]] the target (a title or task key), or what
      // `label` says it shows (a document's title for [[doc:<id>]]).
      .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
      .replace(/\[\[([^\]|]*)\]\]/g, (whole, target: string) => {
        const shown = label(target.trim());
        return shown === null ? whole : ` ${shown} `;
      })
      // <https://autolinks> and inline HTML tags (skipped when rendered).
      .replace(/<[^>\n]*>/g, " "),
  );
}

/**
 * The text a reader sees, roughly: tags, link targets and wiki-link targets dropped, entities
 * decoded. Markdown code (fences, spans, <pre>/<code>) shows as written, so it stays raw (ST-134).
 */
function readableText(
  content: string,
  format: DocumentFormat,
  label: WikiLabel = () => null,
): string {
  if (format === "html") {
    return decodeEntities(
      content
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]*>/g, " "),
    );
  }
  // maskCode blanks code out with spaces: runs that differ from the content are code.
  const masked = maskCode(content);
  let out = "";
  const inCode = (at: number) => masked[at] !== content[at];
  let start = 0;
  for (let i = 1; i <= content.length; i++) {
    if (i < content.length && inCode(i) === inCode(start)) continue;
    const run = content.slice(start, i);
    out += inCode(start) ? ` ${run} ` : readableMarkdown(run, label);
    start = i;
  }
  return out;
}

/** Letters and digits only, lower-cased: the comparable skeleton of a text. */
export function skeleton(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

/**
 * The skeleton of `text` with, for each of its code units, the offset in `text` it comes from,
 * so a match in the skeleton maps back to a range of the text (the web app highlights quotes).
 */
export function skeletonIndex(text: string): {
  skeleton: string;
  offsets: number[];
} {
  let out = "";
  const offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      const folded = char.toLowerCase();
      out += folded;
      for (let i = 0; i < folded.length; i++) offsets.push(offset);
    }
    offset += char.length;
  }
  return { skeleton: out, offsets };
}

/** A document's content with its skeleton, built once to match many quotes (documentSkeleton). */
export interface DocumentSkeleton {
  content: string;
  skeleton: string;
}

/** The skeleton of what a reader sees of a document; `label` names what `[[doc:<id>]]` links show. */
export function documentSkeleton(
  content: string,
  format: DocumentFormat,
  label?: WikiLabel,
): DocumentSkeleton {
  return { content, skeleton: skeleton(readableText(content, format, label)) };
}

/** Whether `quote` (as a reader sees it) occurs in a document, given its documentSkeleton. */
export function quoteOccursInSkeleton(
  document: DocumentSkeleton,
  quote: string,
): boolean {
  // A quote may be copied from the source (`caf&eacute;`) or the rendered page (`café`); in code,
  // where entities show as written, the source form is what a reader sees.
  const needles = [skeleton(decodeEntities(quote)), skeleton(quote)];
  // A quote of only punctuation or symbols: compare it as written.
  if (needles.every((n) => !n)) return document.content.includes(quote.trim());
  return needles.some((n) => n !== "" && document.skeleton.includes(n));
}

/** Whether `quote` (as a reader sees it) still occurs in a document's content. */
export function quoteOccursIn(
  content: string,
  format: DocumentFormat,
  quote: string,
  label?: WikiLabel,
): boolean {
  return quoteOccursInSkeleton(documentSkeleton(content, format, label), quote);
}
