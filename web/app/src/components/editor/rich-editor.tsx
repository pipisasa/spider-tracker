import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { useRef } from "react";
import { EditorBubbleMenu } from "./bubble-menu";
import { DragHandle } from "./drag-handle";
import "./editor.css";
import { markdownExtensions } from "./extensions";
import { SlashCommand } from "./slash-command";

/**
 * Notion-style WYSIWYG editor over a Markdown string: loads `value` once and
 * reports every change (never the initial load) as Markdown. Remount it (key) to load new content.
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
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useEditor({
    extensions: [
      ...markdownExtensions(),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? `Heading ${String(node.attrs.level)}`
            : placeholder,
        includeChildren: false,
      }),
      SlashCommand,
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
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
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
