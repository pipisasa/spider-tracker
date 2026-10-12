// A project's board (ST-93): its task columns, one per status of the task workflow, then (when
// release columns are on, the default) one column per status of the release workflow holding
// release cards. Shared by the web app and tests; browser-safe, no database imports.

import type { ProjectDetailDto, StatusDto, TaskShippingDto } from "./contracts";
import { workflowOf } from "./statuses";

/** Board settings (ST-93); release columns are on unless turned off. */
export interface BoardSettings {
  releaseColumns?: boolean;
}

export const DEFAULT_BOARD_SETTINGS: Required<BoardSettings> = { releaseColumns: true };

interface Card {
  statusId: string;
  sortKey: string;
}

export type BoardColumn<T extends Card, R extends Card> =
  | { type: "tasks"; status: StatusDto; tasks: T[] }
  | { type: "releases"; status: StatusDto; releases: R[] };

const bySortKey = (a: Card, b: Card) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);

/**
 * The board's columns in order: the task workflow's statuses with their tasks, then, with release
 * columns on, the release workflow's statuses with their releases. Cards are in sort-key order;
 * cards whose status isn't in the workflow are left out.
 */
export function boardColumns<T extends Card, R extends Card>(
  project: Pick<ProjectDetailDto, "statuses"> & { workflows?: Partial<ProjectDetailDto["workflows"]> },
  tasks: T[],
  releases: R[],
  settings: BoardSettings = {},
): BoardColumn<T, R>[] {
  const { releaseColumns } = { ...DEFAULT_BOARD_SETTINGS, ...settings };
  const sortedTasks = [...tasks].sort(bySortKey);
  const columns: BoardColumn<T, R>[] = workflowOf(project, "task").map((status) => ({
    type: "tasks",
    status,
    tasks: sortedTasks.filter((t) => t.statusId === status.id),
  }));
  if (!releaseColumns) return columns;
  const sortedReleases = [...releases].sort(bySortKey);
  for (const status of workflowOf(project, "release")) {
    columns.push({ type: "releases", status, releases: sortedReleases.filter((r) => r.statusId === status.id) });
  }
  return columns;
}

/**
 * A Done card's shipping state in words: "not in a release", "2026.10.14 · on staging",
 * "shipped 2026.10.12", "no code", or "in a release" when the release is out of the viewer's sight.
 */
export function shippingLabel(shipping: TaskShippingDto | null | undefined): string | null {
  if (!shipping) return null;
  switch (shipping.state) {
    case "not_in_release":
      return "not in a release";
    case "no_code":
      return "no code";
    case "shipped":
      return shipping.release ? `shipped ${shipping.release.title}` : "shipped";
    case "in_release":
      return shipping.release ? `${shipping.release.title} · ${shipping.release.status.name.toLowerCase()}` : "in a release";
  }
}
