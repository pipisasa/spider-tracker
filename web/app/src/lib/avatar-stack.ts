/** Splits items into the visible ones and the count hidden behind a "+N" chip. */
export function splitStack<T>(
  items: T[],
  max = 3,
): { visible: T[]; overflow: number } {
  const limit = Math.max(0, max);
  return {
    visible: items.slice(0, limit),
    overflow: Math.max(0, items.length - limit),
  };
}
