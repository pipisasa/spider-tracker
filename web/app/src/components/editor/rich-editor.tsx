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
 * reports every change as Markdown. Remount it (key) to load new content.
 */
export default function RichEditor({
  value,
  onChange,
  onBlur,
  placeholder = "Type '/' for commands",
  autofocus = "end",
  label = "Content",
  className = "min-h-[60vh] pb-24",
}: {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autofocus?: "end" | false;
  label?: string;
  className?: string;
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
    autofocus,
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
      className={cn("relative flex-1 cursor-text pl-7", className)}
      onClick={(e) => {
        if (e.target === e.currentTarget) editor.commands.focus("end");
      }}
    >
      <EditorContent editor={editor} />
      <EditorBubbleMenu editor={editor} />
      <DragHandle editor={editor} container={container} />
    </div>
  );
}
