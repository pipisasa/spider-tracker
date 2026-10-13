// Keyboard shortcuts (ST-16): the shortcut table and the pure helpers behind it (key parsing, "g then x" sequences,
// "is the user typing"). The React side lives in use-shortcuts.ts.

export type ShortcutId =
  | "new-task"
  | "go-board"
  | "go-list"
  | "go-docs"
  | "go-projects"
  | "focus-search"
  | "help"
  | "edit-title"
  | "assign";

export interface ShortcutDef {
  id: ShortcutId;
  /** Pressed one after another, e.g. ["g", "b"]. */
  keys: readonly string[];
  label: string;
  group: "General" | "Go to" | "Task page";
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: "new-task",
    keys: ["c"],
    label: "New task in this project",
    group: "General",
  },
  {
    id: "focus-search",
    keys: ["/"],
    label: "Focus the task filter",
    group: "General",
  },
  {
    id: "help",
    keys: ["?"],
    label: "Show keyboard shortcuts",
    group: "General",
  },
  {
    id: "go-board",
    keys: ["g", "b"],
    label: "Board of this project",
    group: "Go to",
  },
  {
    id: "go-list",
    keys: ["g", "l"],
    label: "List of this project",
    group: "Go to",
  },
  {
    id: "go-docs",
    keys: ["g", "d"],
    label: "Documents of this project",
    group: "Go to",
  },
  {
    id: "go-projects",
    keys: ["g", "p"],
    label: "Projects (home)",
    group: "Go to",
  },
  {
    id: "edit-title",
    keys: ["e"],
    label: "Edit the title",
    group: "Task page",
  },
  {
    id: "assign",
    keys: ["a"],
    label: "Open the assignee picker",
    group: "Task page",
  },
];

export const SEQUENCE_TIMEOUT_MS = 1000;

export const shortcutKeys = (id: ShortcutId): readonly string[] =>
  SHORTCUTS.find((s) => s.id === id)?.keys ?? [];

/** Text for a hint such as "g then b" or "c". */
export const formatKeys = (keys: readonly string[]): string =>
  keys.join(" then ");

interface KeyEventLike {
  key: string;
  /** Physical key, e.g. "KeyC"; used when the layout isn't Latin. */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** The key to feed to sequences, or null for modified presses (those belong to the browser/OS) and bare modifiers. */
export function shortcutKey(event: KeyEventLike): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key.length !== 1) return null;
  // Non-Latin layouts (e.g. Russian: "с" on the C key) fall back to the physical key.
  if (
    /^[a-z]$/i.test(event.key) === false &&
    event.code &&
    /^Key[A-Z]$/.test(event.code)
  ) {
    return event.code.slice(3).toLowerCase();
  }
  return event.key.toLowerCase();
}

/** Cmd+K (macOS) or Ctrl+K. */
export const isPaletteKey = (
  event: KeyEventLike & { shiftKey?: boolean },
): boolean =>
  // The physical K key counts only when the layout isn't Latin (on Dvorak, physical K is "t").
  (event.key.toLowerCase() === "k" ||
    (!/^[a-z]$/i.test(event.key) && event.code === "KeyK")) &&
  (event.metaKey === true || event.ctrlKey === true) &&
  !event.altKey &&
  !event.shiftKey;

export interface SequenceState {
  keys: readonly string[];
  at: number;
}

export const EMPTY_SEQUENCE: SequenceState = { keys: [], at: 0 };

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);
const startsWith = (full: readonly string[], prefix: readonly string[]) =>
  prefix.length < full.length && prefix.every((k, i) => k === full[i]);

/**
 * Feeds one key into the sequence matcher. Returns the new state and the shortcut that just completed, if any.
 * A pending prefix ("g") expires after `timeoutMs`; a key that breaks the sequence starts a new one.
 */
export function advanceSequence(
  state: SequenceState,
  key: string,
  now: number,
  defs: readonly ShortcutDef[] = SHORTCUTS,
  timeoutMs: number = SEQUENCE_TIMEOUT_MS,
): { state: SequenceState; matched: ShortcutId | null } {
  const pending =
    state.keys.length > 0 && now - state.at <= timeoutMs ? state.keys : [];
  for (const attempt of pending.length > 0
    ? [[...pending, key], [key]]
    : [[key]]) {
    const exact = defs.find((d) => sameKeys(d.keys, attempt));
    if (exact) return { state: EMPTY_SEQUENCE, matched: exact.id };
    if (defs.some((d) => startsWith(d.keys, attempt)))
      return { state: { keys: attempt, at: now }, matched: null };
  }
  return { state: EMPTY_SEQUENCE, matched: null };
}

/** The bits of an element we look at (a DOM Element satisfies it; tests pass plain objects). */
export interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "image",
  "file",
  "range",
  "color",
]);

/** True when key presses go into a text field (so shortcuts must stay out of the way). */
export function isEditableElement(
  target: ElementLike | null | undefined,
): boolean {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (target.getAttribute?.("type") ?? "text").toLowerCase();
    return !NON_TEXT_INPUTS.has(type);
  }
  if (target.isContentEditable) return true;
  const editable = target.getAttribute?.("contenteditable");
  if (editable !== null && editable !== undefined && editable !== "false")
    return true;
  return target.getAttribute?.("role") === "textbox";
}

/** Task keys such as "st-12" typed in the palette; returns the normalised key ("ST-12") or null. */
export function parseTaskKey(text: string): string | null {
  const match = /^([a-z][a-z0-9]*)-(\d+)$/i.exec(text.trim());
  return match ? `${match[1]?.toUpperCase()}-${match[2]}` : null;
}

/** The project key a task key belongs to ("ST-12" -> "ST"). */
export const projectKeyOfTask = (taskKey: string): string =>
  taskKey.slice(0, taskKey.lastIndexOf("-"));
