import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { useRef } from "react";
import { markdownChanged } from "./markdown-change";
import { EditorBubbleMenu } from "./bubble-menu";
import { DragHandle } from "./drag-handle";
import "./editor.css";
import { markdownExtensions } from "./extensions";
import { SlashCommand } from "./slash-command";
import type { WikiLinkHost } from "./wiki-link";
import { WikiLinkSuggestion } from "./wiki-link-suggestion";

/**
 * Notion-style WYSIWYG editor over a Markdown string: loads `value` once and
 * reports every real change (never the initial load, nor tiptap's own trailing-paragraph fix-up) as Markdown. Remount it (key) to load new content.
 */
export default function RichEditor({
  value,
  onChange,
  onBlur,
  placeholder = "Type '/' for commands",
  autofocus = "end",
  label = "Content",
  className = "min-h-[60vh] pb-24",
  editable = true,
  wikiLinks,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autofocus?: "end" | false;
  label?: string;
  className?: string;
  /** False renders the content read-only: no toolbar, slash menu or drag handle. */
  editable?: boolean;
  /** Resolves, opens and suggests `[[links]]`; without it they render but don't open. */
  wikiLinks?: WikiLinkHost;
}) {
  const container = useRef<HTMLDivElement>(null);
  // The Markdown last known to the parent; reset whenever the editor is created.
  const lastMarkdown = useRef(value);
  // Links read the latest host on each click and suggestion, without recreating the editor.
  const wikiHost = useRef(wikiLinks ?? null);
  wikiHost.current = wikiLinks ?? null;
  const editor = useEditor({
    extensions: [
      ...markdownExtensions(() => wikiHost.current),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? `Heading ${String(node.attrs.level)}`
            : placeholder,
        includeChildren: false,
      }),
      SlashCommand,
      WikiLinkSuggestion.configure({ host: () => wikiHost.current }),
    ],
    content: value,
    contentType: "markdown",
    autofocus: editable ? autofocus : false,
    editable,
    editorProps: {
      attributes: {
        "aria-label": label,
        class:
          "rich-editor prose prose-sm max-w-none dark:prose-invert sm:prose-base focus:outline-none",
      },
    },
    onCreate: ({ editor: e }) => {
      lastMarkdown.current = e.getMarkdown();
    },
    onUpdate: ({ editor: e }) => {
      const markdown = e.getMarkdown();
      if (!markdownChanged(lastMarkdown.current, markdown)) return;
      lastMarkdown.current = markdown;
      onChange(markdown);
    },
    onBlur: () => onBlur?.(),
  });

  return (
    <div
      ref={container}
      className={cn("relative flex-1 pl-7", editable && "cursor-text", className)}
      onClick={(e) => {
        if (editable && e.target === e.currentTarget)
          editor.commands.focus("end");
      }}
    >
      <EditorContent editor={editor} />
      {editable && <EditorBubbleMenu editor={editor} />}
      {editable && <DragHandle editor={editor} container={container} />}
    </div>
  );
}
