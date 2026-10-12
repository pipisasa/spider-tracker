import type { TaskDto } from "@repo/core/contracts";
import { viewFiltersSchema, type ViewFilters } from "@repo/core/schemas";

// Filters of the project page (ST-15): they live in the URL search params, so links can be
// shared, and are the same shape as saved views. Values within a key are OR-ed, keys AND-ed;
// tags follow `tagMatch` (all of them by default, like the API; `?tagMatch=any` for any).

export type TaskFilters = ViewFilters;

export const FILTER_KEYS = ["status", "assignee", "priority", "tag", "tagMatch", "q"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Search params may arrive as a single value (`?tag=x`) or an array; anything unusable is dropped. */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const unique = <T,>(items: T[]) => [...new Set(items)];

/** Reads filters out of URL search params, ignoring malformed values instead of failing. */
export function parseFilters(search: Record<string, unknown>): TaskFilters {
  const filters: TaskFilters = {};
  const status = unique(list(search.status).filter((v): v is string => typeof v === "string" && UUID.test(v)));
  if (status.length) filters.status = status;
  const assignee = unique(
    list(search.assignee).filter((v): v is string => typeof v === "string" && (v === "me" || v === "none" || UUID.test(v))),
  );
  if (assignee.length) filters.assignee = assignee;
  const priority = unique(
    list(search.priority)
      .map((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v))
      .filter((v): v is 0 | 1 | 2 | 3 | 4 => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4),
  );
  if (priority.length) filters.priority = priority;
  const tag = unique(list(search.tag).filter((v): v is string => typeof v === "string" && UUID.test(v)));
  if (tag.length) filters.tag = tag;
  // "all" is the default, so only "any" is kept.
  if (search.tagMatch === "any") filters.tagMatch = "any";
  // The router JSON-parses search values, so `?q=123` arrives as a number.
  const raw = typeof search.q === "number" ? String(search.q) : search.q;
  const q = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
  if (q) filters.q = q;
  return filters;
}

/** Search params for the filters, leaving out empty ones. */
export function filtersToSearch(filters: TaskFilters): TaskFilters {
  return parseFilters({ ...filters });
}

/** Normalises stored view filters (an old view may hold values that no longer parse). */
export function normalizeFilters(filters: unknown): TaskFilters {
  const parsed = viewFiltersSchema.safeParse(filters);
  return parsed.success ? parseFilters(parsed.data) : {};
}

export const activeFilterCount = (filters: TaskFilters) =>
  (filters.status?.length ?? 0) +
  (filters.assignee?.length ?? 0) +
  (filters.priority?.length ?? 0) +
  (filters.tag?.length ?? 0) +
  (filters.q ? 1 : 0);

export const isEmptyFilters = (filters: TaskFilters) => activeFilterCount(filters) === 0;

/** Whether two filter sets select the same tasks (order of values doesn't matter). */
export function sameFilters(a: TaskFilters, b: TaskFilters): boolean {
  const norm = (f: TaskFilters) =>
    JSON.stringify([
      [...(f.status ?? [])].sort(),
      [...(f.assignee ?? [])].sort(),
      [...(f.priority ?? [])].sort(),
      [...(f.tag ?? [])].sort(),
      // With fewer than two tags, all and any select the same tasks.
      (f.tag?.length ?? 0) > 1 ? (f.tagMatch ?? "all") : "",
      (f.q ?? "").trim().toLowerCase(),
    ]);
  return norm(a) === norm(b);
}

/** Toggles a value of a multi-select filter. */
export function toggleValue<T>(values: T[] | undefined, value: T): T[] {
  const current = values ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

/** The tasks matching every active filter; `meId` is the viewer's actor id (for `assignee=me`). */
export function applyFilters(tasks: TaskDto[], filters: TaskFilters, meId: string): TaskDto[] {
  if (isEmptyFilters(filters)) return tasks;
  const query = filters.q?.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.status?.length && !filters.status.includes(task.statusId)) return false;
    if (filters.priority?.length && !filters.priority.includes(task.priority)) return false;
    if (filters.tag?.length) {
      const has = (id: string) => task.tagIds.includes(id);
      if (!(filters.tagMatch === "any" ? filters.tag.some(has) : filters.tag.every(has))) return false;
    }
    if (filters.assignee?.length) {
      const wanted = filters.assignee.map((a) => (a === "me" ? meId : a));
      const matches = task.assigneeIds.length === 0 ? wanted.includes("none") : task.assigneeIds.some((id) => wanted.includes(id));
      if (!matches) return false;
    }
    if (query) {
      const haystack = `${task.title} ${task.key}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
