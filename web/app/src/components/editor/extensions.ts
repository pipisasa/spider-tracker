import type { AnyExtension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * The document schema shared by the rich editor and the Markdown round-trip test.
 * Only nodes and marks that serialize to GitHub-flavoured Markdown are enabled,
 * since documents are stored as Markdown.
 */
export function markdownExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false,
      dropcursor: { color: "var(--ring)", width: 2 },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
      },
    }),
    Image,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}
