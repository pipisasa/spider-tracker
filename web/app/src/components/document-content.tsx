import type { WikiLinkHost } from "@/components/editor/wiki-link";
import type { DocumentFormat } from "@repo/core/contracts";
import { WIKI_LINK, parseWikiLink } from "@repo/core/links";
import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Turns `[[target|label]]` in text into wiki-link anchors; code nodes have no text children. */
export function remarkWikiLinks(href: (target: string) => string | null) {
  const split = (value: string): MdNode[] => {
    const out: MdNode[] = [];
    let last = 0;
    for (const match of value.matchAll(WIKI_LINK)) {
      const link = parseWikiLink(match[1] ?? "", match[2]);
      if (!link || match.index === undefined) continue;
      if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
      const target = (match[1] ?? "").trim();
      const url = href(target);
      out.push({
        type: "wikiLink",
        data: {
          hName: "a",
          hProperties: {
            className: url ? "wiki-link" : "wiki-link wiki-link-missing",
            ...(url ? { href: url } : {}),
            "data-target": target,
          },
          hChildren: [{ type: "text", value: link.label ?? target }],
        },
      });
      last = match.index + match[0].length;
    }
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  };
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value?.includes("[[")) return split(child.value);
      walk(child);
      return [child];
    });
  };
  return () => (tree: MdNode) => walk(tree);
}

/**
 * Renders a document. Markdown goes through react-markdown with raw HTML skipped; `[[links]]`
 * open in the app when `wikiLinks` is given (ST-100). HTML runs in a fully sandboxed iframe: no
 * scripts, no same-origin access, no forms or popups, so a document can't touch the app or the
 * session (docs/decisions.md).
 */
export function DocumentContent({
  format,
  content,
  wikiLinks,
}: {
  format: DocumentFormat;
  content: string;
  wikiLinks?: Pick<WikiLinkHost, "href" | "open">;
}) {
  const plugins = useMemo(
    () => [remarkGfm, remarkWikiLinks((t) => wikiLinks?.href(t) ?? null)],
    [wikiLinks],
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => {
        const target = (props as Record<string, unknown>)["data-target"];
        if (typeof target !== "string") return <a {...props} />;
        return (
          <a
            {...props}
            onClick={(e) => {
              // Modified clicks keep the browser's new-tab behaviour when there is a page.
              if (props.href && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
              e.preventDefault();
              wikiLinks?.open(target);
            }}
          />
        );
      },
    }),
    [wikiLinks],
  );

  if (!content.trim())
    return (
      <p className="text-sm text-muted-foreground">This document is empty.</p>
    );
  if (format === "html") {
    return (
      <iframe
        title="Document"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={content}
        className="h-[70vh] w-full resize-y rounded-lg border bg-white dark:brightness-90"
      />
    );
  }
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert sm:prose-base">
      <Markdown remarkPlugins={plugins} components={components} skipHtml>
        {content}
      </Markdown>
    </div>
  );
}
