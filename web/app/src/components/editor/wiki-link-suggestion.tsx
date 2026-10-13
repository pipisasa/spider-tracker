import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  exitSuggestion,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { FileTextIcon, FilePlusIcon, SquareCheckIcon } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { WikiLinkOptions, WikiSuggestion } from "./wiki-link";

type Item = WikiSuggestion & { kind: "document" | "task" | "new" };

type MenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

const WikiMenu = forwardRef<MenuHandle, SuggestionProps<Item, Item>>(
  function WikiMenu({ items, command }, ref) {
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
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (!items.length) return null;
    return (
      <div
        ref={listRef}
        role="listbox"
        aria-label="Link to"
        className="z-50 max-h-72 w-80 overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
      >
        {items.map((item, index) => {
          const Icon =
            item.kind === "task"
              ? SquareCheckIcon
              : item.kind === "new"
                ? FilePlusIcon
                : FileTextIcon;
          return (
            <button
              key={`${item.kind}:${item.target}`}
              type="button"
              role="option"
              data-index={index}
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(item)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {item.kind === "new" ? `Link to “${item.title}”` : item.title}
              </span>
              {item.hint && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  },
);

const wikiKey = new PluginKey("wikiLinkSuggestion");

/** After `[[`, offers documents and tasks; picking one inserts a wiki link (ST-100). */
export const WikiLinkSuggestion = Extension.create<WikiLinkOptions>({
  name: "wikiLinkSuggestion",

  addOptions() {
    return { host: () => null };
  },

  addProseMirrorPlugins() {
    const host = this.options.host;
    return [
      Suggestion<Item, Item>({
        editor: this.editor,
        pluginKey: wikiKey,
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ editor, state, range }) =>
          host() !== null &&
          !editor.isActive("codeBlock") &&
          !editor.isActive("code") &&
          // Once closed, the input rule takes over.
          !state.doc.textBetween(range.from, range.to).includes("]"),
        items: ({ query }) => {
          const found = host()?.suggest(query) ?? [];
          const items: Item[] = found.map((s) => ({
            ...s,
            kind: /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(s.target)
              ? "task"
              : "document",
          }));
          const typed = query.trim();
          if (
            typed &&
            !items.some((i) => i.target.toLowerCase() === typed.toLowerCase())
          )
            items.push({
              target: typed,
              title: typed,
              hint: null,
              kind: "new",
            });
          return items;
        },
        command: ({ editor, range, props }) =>
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "wikiLink",
                attrs: { target: props.target, label: null },
              },
              { type: "text", text: " " },
            ])
            .run(),
        render: () => {
          let component: ReactRenderer<
            MenuHandle,
            SuggestionProps<Item, Item>
          > | null = null;
          let unmount: (() => void) | undefined;
          return {
            onStart: (props) => {
              component = new ReactRenderer(WikiMenu, {
                props,
                editor: props.editor,
              });
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => component?.updateProps(props),
            onKeyDown: ({ event, view }) => {
              if (event.key === "Escape") {
                exitSuggestion(view, wikiKey);
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
