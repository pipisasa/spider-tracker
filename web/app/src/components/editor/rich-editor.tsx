import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
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
}: {
  value: string;
  onChange: (markdown: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useEditor({
    extensions: [
      ...markdownExtensions(),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? `Heading ${String(node.attrs.level)}`
            : "Type '/' for commands",
        includeChildren: false,
      }),
      SlashCommand,
    ],
    content: value,
    contentType: "markdown",
    autofocus: "end",
    editorProps: {
      attributes: {
        "aria-label": "Content",
        class:
          "rich-editor prose prose-sm max-w-none dark:prose-invert sm:prose-base focus:outline-none",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  });

  return (
    <div
      ref={container}
      className="relative min-h-[60vh] flex-1 cursor-text pb-24 pl-7"
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
