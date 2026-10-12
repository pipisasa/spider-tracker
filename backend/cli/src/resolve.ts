import { normalizeHandle } from "@repo/core/schemas";
import { matchStatuses } from "@repo/core/statuses";
import type { ActorDto, Priority, ProjectDetailDto, StatusCategory, StatusDto, TagDto } from "@repo/core/contracts";
import { SpiderApiError } from "@repo/sdk";

export const EXIT = { ok: 0, unexpected: 1, usage: 2, notFound: 3, auth: 4 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error the CLI reports as one line on stderr, exiting with `exitCode`. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly code = "error",
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string) => new CliError(EXIT.usage, message, "validation");

/** Maps an API error to the CLI's exit codes. */
export function fromApiError(err: SpiderApiError): CliError {
  if (err.status === 401 || err.status === 403) return new CliError(EXIT.auth, err.message, err.code);
  if (err.status === 404) return new CliError(EXIT.notFound, err.message, err.code);
  if (err.status === 400 || err.status === 409 || err.status === 422) {
    return new CliError(EXIT.usage, err.message, err.code);
  }
  return new CliError(EXIT.unexpected, err.message, err.code);
}

export const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"] as const;

/** "0"–"4" or a priority name ("high"). */
export function parsePriority(value: string): Priority {
  const v = value.trim().toLowerCase();
  const index = /^[0-4]$/.test(v) ? Number(v) : PRIORITY_NAMES.findIndex((n) => n === v);
  if (index < 0) throw usageError(`Invalid priority "${value}". Use 0-4 or ${PRIORITY_NAMES.join(", ")}`);
  return index as Priority;
}

export function parseLimit(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1) throw usageError(`Invalid limit "${value}". Use a positive integer`);
  return n;
}

export function parseVersion(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1) throw usageError(`Invalid version "${value}". Use a positive integer`);
  return n;
}

export { matchStatuses };

const byPosition = (a: StatusDto, b: StatusDto) => a.position - b.position;

/** The status a name refers to; a category picks its first status in board order. */
export function resolveStatus(project: ProjectDetailDto, name: string): StatusDto {
  const status = matchStatuses(project, name)[0];
  if (!status) {
    throw usageError(
      `Unknown status "${name}" in ${project.key}. Valid statuses: ${project.statuses.map((s) => s.name).join(", ")}`,
    );
  }
  return status;
}

/** The project's first status in a category, in board order. */
export function firstStatus(project: ProjectDetailDto, category: StatusCategory): StatusDto {
  const status = project.statuses.filter((s) => s.category === category).sort(byPosition)[0];
  if (!status) throw usageError(`${project.key} has no "${category}" status`);
  return status;
}

/** Member ids for handles ("alice", "@alice", or "me"), without duplicates. */
export function resolveAssignees(members: ActorDto[], meId: string, handles: string[]): string[] {
  const ids = handles.map((raw) => {
    const handle = normalizeHandle(raw);
    if (handle === "me") return meId;
    const member = members.find((m) => m.handle.toLowerCase() === handle);
    if (!member) {
      throw usageError(`Unknown member "${raw}". Valid handles: me, ${members.map((m) => m.handle).join(", ")}`);
    }
    return member.id;
  });
  return [...new Set(ids)];
}

/** Tag names (case-insensitive, with or without "#") to ids; unknown names list the existing tags. */
export function resolveTags(tags: TagDto[], names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim().replace(/^#/, "")).filter(Boolean))].map((name) => {
    const tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      throw usageError(`Unknown tag "${name}". Existing tags: ${tags.map((t) => t.name).join(", ") || "none"}`);
    }
    return tag.id;
  });
}

export interface TaskListFilter {
  statusIds?: string[];
  /** Actor ids, or "none" for unassigned. */
  assignee?: string[];
  /** The task must carry all of these (or one of them, with `tagMatch: "any"`). */
  tagIds?: string[];
  tagMatch?: "all" | "any";
  priority?: number[];
}

/**
 * The task list filters, applied again on the client: an API from before ST-50 ignores the
 * query parameters and returns every task, which must not reach an agent picking up work.
 */
export function matchesTaskFilter(
  task: { statusId: string; assigneeIds: string[]; tagIds?: string[]; priority: number },
  filter: TaskListFilter,
): boolean {
  if (filter.statusIds && !filter.statusIds.includes(task.statusId)) return false;
  if (filter.priority && !filter.priority.includes(task.priority)) return false;
  if (filter.tagIds) {
    const has = (id: string) => (task.tagIds ?? []).includes(id);
    if (!(filter.tagMatch === "any" ? filter.tagIds.some(has) : filter.tagIds.every(has))) return false;
  }
  if (filter.assignee) {
    const unassigned = filter.assignee.includes("none") && task.assigneeIds.length === 0;
    if (!unassigned && !task.assigneeIds.some((id) => filter.assignee?.includes(id))) return false;
  }
  return true;
}

const RELATION_KINDS = ["blocks", "blocked_by", "relates", "duplicates", "duplicated_by"] as const;
export type RelationKindInput = (typeof RELATION_KINDS)[number];

/** "blocked-by", "Blocked By" and "blocked_by" all mean blocked_by. */
export function parseRelationKind(value: string): RelationKindInput {
  const kind = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const found = RELATION_KINDS.find((k) => k === kind || (k === "relates" && kind === "relates_to"));
  if (!found) throw usageError(`Unknown link kind "${value}". Use one of: blocks, blocked-by, relates, duplicates, duplicated-by`);
  return found;
}
