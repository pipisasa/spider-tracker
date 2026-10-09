import { ActorAvatar } from "@/components/task-fields";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ActorDto } from "@repo/core/contracts";
import { BotIcon } from "lucide-react";
import {
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";

const MAX_SUGGESTIONS = 6;

/** The "@query" being typed right before the caret, if any. */
function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const match = /(?:^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1].toLowerCase() };
}

/**
 * A textarea that suggests members while an @handle is typed. ↑/↓ move, Enter or Tab inserts, Esc closes.
 * Other keys go to `onKeyDown` as usual.
 */
export function MentionTextarea({
  value,
  onValueChange,
  members,
  onKeyDown,
  className,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  members: ActorDto[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const mention = mentionAt(value, caret);
  const suggestions = mention
    ? members
        .filter(
          (m) =>
            m.handle.startsWith(mention.query) ||
            m.name.toLowerCase().includes(mention.query),
        )
        .slice(0, MAX_SUGGESTIONS)
    : [];
  const open =
    mention !== null && suggestions.length > 0 && dismissed !== mention.start;

  function insert(member: ActorDto) {
    if (!mention) return;
    const before = `${value.slice(0, mention.start)}@${member.handle} `;
    onValueChange(before + value.slice(caret));
    setCaret(before.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        insert(suggestions[Math.min(active, suggestions.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(mention.start);
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={ref}
        className={className}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setDismissed(mention?.start ?? null)}
        onFocus={() => setDismissed(null)}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <ul
          role="listbox"
          className="absolute top-full left-0 z-50 mt-1 w-64 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
              // mousedown, not click: keeps focus in the textarea so blur doesn't close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <ActorAvatar actor={m} className="size-5" />
              <span className="truncate">{m.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                {m.type === "agent" && (
                  <BotIcon className="size-3" aria-label="agent" />
                )}
                @{m.handle}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
