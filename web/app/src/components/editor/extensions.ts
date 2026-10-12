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
import { MarkdownFidelity } from "./fidelity";
import { WikiLink, type WikiLinkHost } from "./wiki-link";

/**
 * The document schema shared by the rich editor and the Markdown round-trip test.
 * Only nodes and marks that serialize to GitHub-flavoured Markdown are enabled,
 * since documents are stored as Markdown.
 */
export function markdownExtensions(
  wikiLinkHost: () => WikiLinkHost | null = () => null,
): AnyExtension[] {
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
    WikiLink.configure({ host: wikiLinkHost }),
    Markdown.configure({ markedOptions: { gfm: true } }),
    MarkdownFidelity,
  ];
}
