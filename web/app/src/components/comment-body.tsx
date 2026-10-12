import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Comments are Markdown (GitHub-flavoured, raw HTML skipped, like documents), read like chat:
// a single newline is a line break, and @handles of known members are highlighted.

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const MENTION = /(@[a-z0-9]+(?:-[a-z0-9]+)*)/gi;

/** Splits text nodes into text, line breaks and mention spans; code is left alone. */
function remarkCommentText(handles: Set<string>) {
  const split = (value: string): MdNode[] => {
    const out: MdNode[] = [];
    value.split("\n").forEach((line, i) => {
      if (i > 0) out.push({ type: "break" });
      for (const part of line.split(MENTION)) {
        if (!part) continue;
        if (part.startsWith("@") && handles.has(part.slice(1).toLowerCase())) {
          out.push({
            type: "mention",
            data: {
              hName: "span",
              hProperties: { className: "mention" },
              hChildren: [{ type: "text", value: part }],
            },
          });
        } else out.push({ type: "text", value: part });
      }
    });
    return out;
  };
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value !== undefined)
        return split(child.value);
      walk(child);
      return [child];
    });
  };
  return () => (tree: MdNode) => walk(tree);
}

const components: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

export function CommentBody({
  body,
  handles,
}: {
  body: string;
  handles: Set<string>;
}) {
  const plugins = useMemo(
    () => [remarkGfm, remarkCommentText(handles)],
    [handles],
  );
  return (
    <div className="comment-body prose prose-sm max-w-none break-words dark:prose-invert prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-headings:mt-2 prose-headings:mb-1 prose-blockquote:my-1 [&_.mention]:rounded [&_.mention]:bg-primary/10 [&_.mention]:px-0.5 [&_.mention]:font-medium [&_.mention]:text-primary [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <Markdown remarkPlugins={plugins} components={components} skipHtml>
        {body}
      </Markdown>
    </div>
  );
}
