import { InputRule, mergeAttributes, Node } from "@tiptap/core";

/** What the page hosting an editor tells wiki links (ST-100); absent, links render but don't open. */
export interface WikiLinkHost {
  /** The page a target opens, or null when nothing has that title (drawn dimmed). */
  href: (target: string) => string | null;
  /** The text a link without its own label shows instead of the target, e.g. a document's title for `[[doc:<id>]]`. */
  label?: (target: string) => string | null;
  /** Goes there in the app; a missing document may be created first. */
  open: (target: string) => void;
  /** Documents (and tasks) to offer after `[[`. */
  suggest: (query: string) => WikiSuggestion[];
}

export interface WikiSuggestion {
  /** Written into the link: a document title or a task key. */
  target: string;
  title: string;
  /** Where it lives, e.g. "ST" or "ST-12". */
  hint: string | null;
}

export interface WikiLinkOptions {
  /** Read on every render and click, so the host can change without recreating the editor. */
  host: () => WikiLinkHost | null;
}

/** `[[target]]` or `[[target|label]]` at the start of the source (the tokenizer and the input rule). */
const SOURCE = /^\[\[([^[\]\n|]+?)(?:\|([^[\]\n]*))?\]\]/;
const TYPED = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]*))?\]\]$/;

const attrsOf = (target: string, label: string | undefined) => ({
  target: target.trim(),
  label: label?.trim() ? label.trim() : null,
});

export function wikiLinkMarkdown(target: string, label: string | null): string {
  return `[[${target}${label ? `|${label}` : ""}]]`;
}

/** An Obsidian-style `[[link]]` to a document or a task, kept as such in Markdown. */
export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { host: () => null };
  },

  addAttributes() {
    return {
      target: { default: "" },
      label: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "a[data-wiki-link]",
        getAttrs: (el) => ({
          target: el.getAttribute("data-target") ?? "",
          label: el.getAttribute("data-label"),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const target = String(node.attrs.target);
    const label = node.attrs.label as string | null;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-wiki-link": "",
        "data-target": target,
        "data-label": label ?? undefined,
        class: "wiki-link",
      }),
      label ?? target,
    ];
  },

  renderText({ node }) {
    return wikiLinkMarkdown(String(node.attrs.target), node.attrs.label as string | null);
  },

  addNodeView() {
    return ({ node, editor }) => {
      const target = String(node.attrs.target);
      const dom = document.createElement("a");
      dom.className = "wiki-link";
      dom.dataset.wikiLink = "";
      const label = node.attrs.label as string | null;
      dom.textContent = label ?? target;
      // Re-resolved on hover and click: the documents list may load after the editor opens.
      const refresh = () => {
        const host = this.options.host();
        if (!label) dom.textContent = host?.label?.(target) ?? target;
        const href = host?.href(target) ?? null;
        if (href) dom.href = href;
        else dom.removeAttribute("href");
        dom.classList.toggle("wiki-link-missing", host !== null && !href);
        if (editor.isEditable) dom.title = href ? "⌘/Ctrl-click to open in a new tab" : "No document has this title yet";
        return href;
      };
      refresh();
      dom.addEventListener("mouseenter", refresh);
      dom.addEventListener("click", (event) => {
        event.preventDefault();
        const href = refresh();
        // While editing, a plain click selects the link; opening would leave unsaved changes.
        if (!editor.isEditable) this.options.host()?.open(target);
        else if (href && (event.metaKey || event.ctrlKey)) window.open(href, "_blank", "noopener");
      });
      return { dom };
    };
  },

  addInputRules() {
    // Typing the closing `]]` turns `[[Title]]` into a link.
    // (nodeInputRule would replace only the first capture group, keeping the brackets around it.)
    const type = this.type;
    return [
      new InputRule({
        find: TYPED,
        handler: ({ state, range, match }) => {
          const attrs = attrsOf(match[1] ?? "", match[2]);
          if (!attrs.target) return null;
          state.tr.replaceWith(range.from, range.to, type.create(attrs));
        },
      }),
    ];
  },

  markdownTokenName: "wikiLink",
  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenize: (src) => {
      const match = SOURCE.exec(src);
      if (!match?.[1]?.trim()) return undefined;
      return { type: "wikiLink", raw: match[0], ...attrsOf(match[1], match[2]) };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("wikiLink", {
      target: String(token.target ?? ""),
      label: typeof token.label === "string" ? token.label : null,
    }),
  renderMarkdown: (node) =>
    wikiLinkMarkdown(String(node.attrs?.target ?? ""), (node.attrs?.label as string | null | undefined) ?? null),
});
