import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { GripVerticalIcon } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

type Block = { pos: number; dom: HTMLElement; top: number };

/** The top-level block at (or nearest above) a vertical position. */
function blockAt(editor: Editor, clientY: number): Block | null {
  const { view } = editor;
  let found: Block | null = null;
  view.state.doc.forEach((_node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    if (rect.top <= clientY || !found) {
      const lineHeight = parseFloat(getComputedStyle(dom).lineHeight) || 24;
      found = {
        pos: offset,
        dom,
        top: rect.top + (Math.min(lineHeight, rect.height) - 24) / 2,
      };
    }
  });
  return found;
}

/**
 * A grip in the left gutter of the hovered top-level block. Dragging it selects
 * the block and hands it to ProseMirror's own drag and drop, which moves it.
 */
export function DragHandle({
  editor,
  container,
}: {
  editor: Editor;
  container: RefObject<HTMLDivElement | null>;
}) {
  const [block, setBlock] = useState<Block | null>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      if (!editor.isEditable || editor.view.dragging) return;
      setBlock(blockAt(editor, e.clientY));
    };
    const onLeave = () => setBlock(null);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [editor, container]);

  useEffect(() => {
    const hide = () => setBlock(null);
    editor.on("update", hide);
    return () => {
      editor.off("update", hide);
    };
  }, [editor]);

  if (!block || !container.current) return null;
  const top = block.top - container.current.getBoundingClientRect().top;

  return (
    <button
      type="button"
      draggable
      aria-label="Drag to move block"
      title="Drag to move · click to select"
      style={{ top }}
      className="absolute left-0 flex h-6 w-5 cursor-grab items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground active:cursor-grabbing"
      onClick={() => {
        editor.chain().focus().setNodeSelection(block.pos).run();
      }}
      onDragStart={(e) => {
        const { view } = editor;
        const selection = NodeSelection.create(view.state.doc, block.pos);
        view.dispatch(view.state.tr.setSelection(selection));
        const slice = selection.content();
        const { dom, text } = view.serializeForClipboard(slice);
        e.dataTransfer.clearData();
        e.dataTransfer.setData("text/html", dom.innerHTML);
        e.dataTransfer.setData("text/plain", text);
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setDragImage(block.dom, 0, 0);
        view.dragging = { slice, move: true };
      }}
      onDragEnd={() => {
        editor.view.dragging = null;
        setBlock(null);
      }}
    >
      <GripVerticalIcon className="size-4" />
    </button>
  );
}
