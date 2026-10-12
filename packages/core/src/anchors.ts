// Fragment anchors for document comments (ST-118). A comment quotes the text it is about as a
// reader sees it (selected in the rendered document, or copied from the source). The quote still
// "anchors" while that text occurs in the document; otherwise the comment is outdated. Matching
// compares letters and digits only, so Markdown or HTML markup, link targets, punctuation and
// whitespace between the words don't count: "the **new** plan" anchors "the new plan".
// Browser-safe: no database imports.

import type { DocumentFormat } from "./contracts";

/** The text a reader sees, roughly: tags, link targets and wiki-link targets dropped. */
function readableText(content: string, format: DocumentFormat): string {
  if (format === "html") {
    return content
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return (
    content
      // ![alt](src) and [label](href): only the alt text and label show.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // [[target|label]] shows the label; [[target]] the target (a title or task key).
      .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
      // <https://autolinks> and inline HTML tags (skipped when rendered).
      .replace(/<[^>\n]*>/g, " ")
  );
}

/** Letters and digits only, lower-cased: the comparable skeleton of a text. */
export function skeleton(text: string): string {
  return text.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/**
 * The skeleton of `text` with, for each of its code units, the offset in `text` it comes from,
 * so a match in the skeleton maps back to a range of the text (the web app highlights quotes).
 */
export function skeletonIndex(text: string): { skeleton: string; offsets: number[] } {
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

/** Whether `quote` (as a reader sees it) still occurs in a document's content. */
export function quoteOccursIn(content: string, format: DocumentFormat, quote: string): boolean {
  const needle = skeleton(quote);
  // A quote of only punctuation or symbols: compare it as written.
  if (!needle) return content.includes(quote.trim());
  return skeleton(readableText(content, format)).includes(needle);
}
