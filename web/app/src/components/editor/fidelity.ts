import { Extension } from "@tiptap/core";

type TextNode = { marks?: ({ type: string } | string)[] };
type HtmlToken = { text?: string; raw?: string; block?: boolean };
type ParentNode = { type?: string } | undefined;

/** The slice of @tiptap/markdown's (private) MarkdownManager we adapt. */
type ManagerInternals = {
  codeTypes: Set<string>;
  getSchemaParseDomTags(): Set<string>;
  htmlAsLiteralText(html: string, isBlock: boolean): unknown;
  parseHTMLToken(token: HtmlToken): unknown;
  encodeTextForMarkdown(
    text: string,
    node: TextNode,
    parent: ParentNode,
  ): string;
};

/**
 * Escapes plain text for Markdown, only where the result would otherwise parse
 * differently. @tiptap/markdown escapes `< > &` as entities and every `_ [ ] ~`
 * in sight, which rewrites agent-written Markdown (`Array<string>` became
 * `Array&lt;string&gt;`, `snake_case` became `snake\_case`) and drops the
 * escapes that matter (`1\.`).
 *
 * `isKnownTag` says whether `<name>` is a tag the editor's schema turns into a node or mark.
 */
export function escapeMarkdownText(
  text: string,
  isKnownTag: (name: string) => boolean,
): string {
  let out = text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    // Intraword underscores never emphasise; snake_case stays as typed.
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "\\_")
    // Only text that already reads like a link / reference needs its brackets escaped.
    .replace(/&(?=#?\w+;)/g, "&amp;")
    .replace(/<(?=\/?([A-Za-z][\w-]*))/g, (m, _g, offset: number, whole: string) => {
      const name = /^<\/?([A-Za-z][\w-]*)/.exec(whole.slice(offset))?.[1] ?? "";
      return isKnownTag(name) ? "&lt;" : m;
    });
  if (/\]\s*[([:]/.test(out)) out = out.replace(/([[\]])/g, "\\$1");
  if (out.includes("~~")) out = out.replace(/~/g, "\\~");
  // Line starts that would turn the paragraph into a list, heading or quote.
  return out
    .replace(/(^|\n)(\d{1,9})([.)])(?=\s|$)/g, "$1$2\\$3")
    .replace(/(^|\n)([-+])(?=\s|$)/g, "$1\\$2")
    .replace(/(^|\n)(#{1,6})(?=\s|$)/g, "$1\\$2")
    .replace(/(^|\n)>/g, "$1\\>");
}

/**
 * Makes the Markdown the editor writes stay close to what was loaded: angle
 * brackets and ampersands pass through, `1\.`-style escapes are kept.
 */
export const MarkdownFidelity = Extension.create({
  name: "markdownFidelity",
  onBeforeCreate() {
    // The manager has no hook for text escaping, so replace its (private) method.
    const manager = this.editor.markdown as unknown as
      | ManagerInternals
      | undefined;
    if (!manager) return;
    // In a browser the manager parses HTML through the schema, which silently
    // drops tags it has no node or mark for (`<kbd>`, `<div>`, comments). Keep
    // such HTML as literal text instead; the serializer above writes it back raw.
    const parseHtml = manager.parseHTMLToken.bind(manager);
    manager.parseHTMLToken = (token) => {
      const html = token.text ?? token.raw ?? "";
      const known = manager.getSchemaParseDomTags();
      const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) =>
        (m[1] ?? "").toLowerCase(),
      );
      if (html.trim() && !tags.some((t) => known.has(t)))
        return manager.htmlAsLiteralText(html, token.block === true);
      return parseHtml(token);
    };
    manager.encodeTextForMarkdown = (text, node, parent) => {
      const inCode =
        (parent?.type !== undefined && manager.codeTypes.has(parent.type)) ||
        (node.marks ?? []).some((m) =>
          manager.codeTypes.has(typeof m === "string" ? m : m.type),
        );
      if (inCode) return text;
      return escapeMarkdownText(
        text,
        (name) => manager.getSchemaParseDomTags().has(name.toLowerCase()),
      );
    };
  },
});
