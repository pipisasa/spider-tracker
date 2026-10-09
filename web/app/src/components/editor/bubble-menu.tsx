import { cn } from "@/lib/utils";
import { TextSelection } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  UnlinkIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

function MenuButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-xs font-medium hover:bg-muted [&_svg]:size-4",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Formatting toolbar shown over a text selection. */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      href: e.getAttributes("link").href as string | undefined,
      paragraph: e.isActive("paragraph"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
    }),
  });

  function applyLink() {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinkOpen(false);
  }

  const chain = () => editor.chain().focus();

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: e, state: s }) =>
        e.isEditable &&
        !s.selection.empty &&
        s.selection instanceof TextSelection &&
        !e.isActive("codeBlock")
      }
      options={{ placement: "top-start", onHide: () => setLinkOpen(false) }}
      className="flex items-center gap-0.5 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {linkOpen ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            type="url"
            placeholder="Paste a link…"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setLinkOpen(false);
                editor.commands.focus();
              }
            }}
            className="h-7 w-56 rounded-md bg-transparent px-2 text-sm outline-none"
          />
          <MenuButton label="Apply link" onClick={applyLink}>
            <LinkIcon />
          </MenuButton>
          {state.link && (
            <MenuButton
              label="Remove link"
              onClick={() => {
                chain().extendMarkRange("link").unsetLink().run();
                setLinkOpen(false);
              }}
            >
              <UnlinkIcon />
            </MenuButton>
          )}
        </form>
      ) : (
        <>
          <MenuButton
            label="Text"
            active={state.paragraph}
            onClick={() => chain().setParagraph().run()}
          >
            Aa
          </MenuButton>
          {([1, 2, 3] as const).map((level) => (
            <MenuButton
              key={level}
              label={`Heading ${level}`}
              active={state[`h${level}`]}
              onClick={() => chain().toggleHeading({ level }).run()}
            >
              H{level}
            </MenuButton>
          ))}
          <span className="mx-0.5 h-5 w-px bg-border" />
          <MenuButton
            label="Bold"
            active={state.bold}
            onClick={() => chain().toggleBold().run()}
          >
            <BoldIcon />
          </MenuButton>
          <MenuButton
            label="Italic"
            active={state.italic}
            onClick={() => chain().toggleItalic().run()}
          >
            <ItalicIcon />
          </MenuButton>
          <MenuButton
            label="Strikethrough"
            active={state.strike}
            onClick={() => chain().toggleStrike().run()}
          >
            <StrikethroughIcon />
          </MenuButton>
          <MenuButton
            label="Inline code"
            active={state.code}
            onClick={() => chain().toggleCode().run()}
          >
            <CodeIcon />
          </MenuButton>
          <MenuButton
            label="Link"
            active={state.link}
            onClick={() => {
              setHref(state.href ?? "");
              setLinkOpen(true);
            }}
          >
            <LinkIcon />
          </MenuButton>
        </>
      )}
    </BubbleMenu>
  );
}
