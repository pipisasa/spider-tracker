/**
 * Whether the editor's Markdown really differs from the last one we know of.
 * Tiptap emits `update` for appended transactions too (TrailingNode adds an empty
 * paragraph on the first transaction), so `update` alone doesn't mean an edit.
 * Trailing whitespace is ignored for that reason.
 */
export function markdownChanged(previous: string, next: string): boolean {
  return previous.trimEnd() !== next.trimEnd();
}
