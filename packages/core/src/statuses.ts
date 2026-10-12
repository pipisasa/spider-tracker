import type { ProjectDetailDto, StatusCategory, StatusDto, TaskKind } from "./contracts";

// Status lookup shared by the MCP server, the CLI and the web app (no database imports).

const KIND_ORDER: TaskKind[] = ["task", "release", "milestone"];

const byPosition = (a: StatusDto, b: StatusDto) => a.position - b.position;

type ProjectStatuses = Pick<ProjectDetailDto, "statuses"> & { workflows?: Partial<ProjectDetailDto["workflows"]> };

/**
 * One kind's workflow, in board order (ST-90). Servers from before kinds send only `statuses`
 * (the task workflow) and no `kind` on them: those read as kind "task".
 */
export function workflowOf(project: ProjectStatuses, kind: TaskKind = "task"): StatusDto[] {
  const statuses = project.workflows?.[kind] ?? (kind === "task" ? project.statuses : []);
  return statuses.map((s) => (s.kind ? s : { ...s, kind: "task" as const })).sort(byPosition);
}

/** Every status of the project, kind by kind (task, release, milestone), each in board order. */
export function allStatuses(project: ProjectStatuses): StatusDto[] {
  return KIND_ORDER.flatMap((kind) => workflowOf(project, kind));
}

/** A task's kind; tasks from servers before kinds (ST-90) have none and are ordinary tasks. */
export const kindOf = (task: { kind?: TaskKind }): TaskKind => task.kind ?? "task";

/**
 * Statuses matching a name or a category ("In Progress", "in progress", "in_progress"),
 * case-insensitively, in one kind's workflow (default "task"), or in every workflow with "all".
 */
export function matchStatuses(project: ProjectStatuses, query: string, kind: TaskKind | "all" = "task"): StatusDto[] {
  const statuses = kind === "all" ? allStatuses(project) : workflowOf(project, kind);
  const q = query.trim().toLowerCase();
  const byName = statuses.filter((s) => s.name.toLowerCase() === q);
  if (byName.length > 0) return byName;
  const category = q.replace(/[\s-]+/g, "_");
  return statuses.filter((s) => s.category === category);
}

/** The first status of a category in one kind's workflow, in board order. */
export function firstStatusOf(project: ProjectStatuses, category: StatusCategory, kind: TaskKind = "task"): StatusDto | undefined {
  return workflowOf(project, kind).find((s) => s.category === category);
}

/** "Unknown status …" message listing a workflow's statuses. */
export function unknownStatusMessage(project: ProjectStatuses & { key: string }, value: string, kind: TaskKind | "all" = "task"): string {
  const statuses = kind === "all" ? allStatuses(project) : workflowOf(project, kind);
  const names = [...new Set(statuses.map((s) => s.name))].join(", ");
  const where = kind === "all" || kind === "task" ? project.key : `${project.key}'s ${kind} workflow`;
  return `Unknown status "${value}" in ${where}. Valid statuses: ${names}`;
}
