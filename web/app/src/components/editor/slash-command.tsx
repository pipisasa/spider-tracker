import type { Editor, Range } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  exitSuggestion,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  type LucideIcon,
  MinusIcon,
  TableIcon,
  TextIcon,
  TextQuoteIcon,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type SlashItem = {
  title: string;
  description: string;
  icon: LucideIcon;
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
};

const ITEMS: SlashItem[] = [
  {
    title: "Text",
    description: "Plain paragraph",
    icon: TextIcon,
    keywords: ["paragraph", "p"],
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  ...([1, 2, 3] as const).map((level): SlashItem => ({
    title: `Heading ${level}`,
    description: ["Large", "Medium", "Small"][level - 1] + " section heading",
    icon: [Heading1Icon, Heading2Icon, Heading3Icon][level - 1],
    keywords: [`h${level}`, "title"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level }).run(),
  })),
  {
    title: "Bulleted list",
    description: "A simple bulleted list",
    icon: ListIcon,
    keywords: ["ul", "unordered", "bullet"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    description: "A list with numbering",
    icon: ListOrderedIcon,
    keywords: ["ol", "ordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "To-do list",
    description: "Track tasks with checkboxes",
    icon: ListTodoIcon,
    keywords: ["task", "todo", "checkbox"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: "Quote",
    description: "Capture a quote",
    icon: TextQuoteIcon,
    keywords: ["blockquote"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).setParagraph().toggleBlockquote().run(),
  },
  {
    title: "Code block",
    description: "Monospaced code",
    icon: CodeIcon,
    keywords: ["code", "pre", "snippet"],
    run: (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run(),
  },
  {
    title: "Divider",
    description: "Visually divide blocks",
    icon: MinusIcon,
    keywords: ["hr", "rule", "separator", "line"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    title: "Table",
    description: "A 3×3 table",
    icon: TableIcon,
    keywords: ["grid"],
    run: (e, r) =>
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.startsWith(q)),
  );
}

type MenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

const SlashMenu = forwardRef<MenuHandle, SuggestionProps<SlashItem, SlashItem>>(
  function SlashMenu({ items, command }, ref) {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => setSelected(0), [items]);
    useEffect(() => {
      listRef.current
        ?.querySelector(`[data-index="${selected}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (!items.length) return false;
        if (event.key === "ArrowDown") {
          setSelected((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    return (
      <div
        ref={listRef}
        role="listbox"
        className="z-50 max-h-80 w-72 overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
      >
        {items.length ? (
          items.map((item, index) => (
            <button
              key={item.title}
              type="button"
              role="option"
              data-index={index}
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(item)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                <item.icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{item.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="px-2 py-1.5 text-muted-foreground">No results</p>
        )}
      </div>
    );
  },
);

const slashKey = new PluginKey("slashCommand");

/** Notion-style `/` menu for inserting blocks. */
export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: "/",
        allow: ({ editor }) => !editor.isActive("codeBlock"),
        items: ({ query }) => filterItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let component: ReactRenderer<
            MenuHandle,
            SuggestionProps<SlashItem, SlashItem>
          > | null = null;
          let unmount: (() => void) | undefined;
          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenu, {
                props,
                editor: props.editor,
              });
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => component?.updateProps(props),
            onKeyDown: ({ event, view }) => {
              if (event.key === "Escape") {
                exitSuggestion(view, slashKey);
                return true;
              }
              return component?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
              unmount?.();
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});
