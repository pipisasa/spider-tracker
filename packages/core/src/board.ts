// A project's board (ST-93): its task columns, one per status of the task workflow, then (when
// release columns are on, the default) one column per status of the release workflow holding
// release cards. Shared by the web app and tests; browser-safe, no database imports.

import type { DeploymentDto, MilestoneProgressDto, ProjectDetailDto, ReleaseDto, StatusDto, TaskShippingDto } from "./contracts";
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
/**
 * A milestone's progress in words (ST-96): "3/5 done · 1/2 shipped"; the shipped part only once a
 * Done task has code, and "no tasks" for an empty one.
 */
export function milestoneProgressLabel(progress: MilestoneProgressDto): string {
  if (progress.total === 0) return "no tasks";
  const done = `${progress.done}/${progress.total} done`;
  return progress.withCode > 0 ? `${done} · ${progress.shipped}/${progress.withCode} shipped` : done;
}

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

/** One app × environment of a release (ST-94): its latest deployment, if any, and how many there were. */
export interface DeploymentCell {
  appId: string;
  app: string;
  environment: string;
  /** The app's last environment, which Released waits for. */
  production: boolean;
  latest: DeploymentDto | null;
  count: number;
}

/**
 * A release's deployments per app and environment, apps in the release's order and environments in
 * each app's deploy order. Apps without environments (a CLI) have no cells.
 */
export function deploymentCells(release: Pick<ReleaseDto, "apps" | "deployments">): DeploymentCell[] {
  const deployments = release.deployments ?? [];
  return release.apps.flatMap((app) =>
    app.environments.map((environment, i): DeploymentCell => {
      const here = deployments.filter((d) => d.appId === app.appId && d.environment === environment);
      return {
        appId: app.appId,
        app: app.name,
        environment,
        production: i === app.environments.length - 1,
        latest: here[0] ?? null,
        count: here.length,
      };
    }),
  );
}

/** The apps a release still has to deploy to production before it can be marked Released (ST-94). */
export const appsAwaitingProduction = (release: Pick<ReleaseDto, "apps" | "deployments">): DeploymentCell[] =>
  deploymentCells(release).filter((c) => c.production && !c.latest);
