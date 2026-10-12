import { TASK_KINDS, isOverdue, normalizeHandle, statusCategorySchema, taskDateSchema } from "@repo/core/schemas";
import { firstStatusOf, kindOf, matchStatuses, unknownStatusMessage, workflowOf } from "@repo/core/statuses";
import type { ActorDto, Priority, ProjectDetailDto, StatusCategory, StatusDto, TagDto, TaskKind } from "@repo/core/contracts";
import { SpiderApiError } from "@repo/sdk";

export const EXIT = { ok: 0, unexpected: 1, usage: 2, notFound: 3, auth: 4 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error the CLI reports as one line on stderr, exiting with `exitCode`. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly code = "error",
    /** What the error is about (the pull request already open); in `--json` errors as `error.url`. */
    readonly url?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string) => new CliError(EXIT.usage, message, "validation");

/** Maps an API error to the CLI's exit codes; `hint` is appended to the message. Never an empty message. */
export function fromApiError(err: SpiderApiError, hint = ""): CliError {
  const message = `${err.message.trim() || `The server answered ${err.status}${err.code !== "unknown" ? ` (${err.code})` : ""}`}${hint}`;
  if (err.status === 401 || err.status === 403) return new CliError(EXIT.auth, message, err.code);
  if (err.status === 404) return new CliError(EXIT.notFound, message, err.code);
  if (err.status === 400 || err.status === 409 || err.status === 422) {
    return new CliError(EXIT.usage, message, err.code, err.url);
  }
  return new CliError(EXIT.unexpected, message, err.code);
}

export const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"] as const;

/** "0"–"4" or a priority name ("high"). */
export function parsePriority(value: string): Priority {
  const v = value.trim().toLowerCase();
  const index = /^[0-4]$/.test(v) ? Number(v) : PRIORITY_NAMES.findIndex((n) => n === v);
  if (index < 0) throw usageError(`Invalid priority "${value}". Use 0-4 or ${PRIORITY_NAMES.join(", ")}`);
  return index as Priority;
}

/** A date option ("--start", "--target"): "YYYY-MM-DD", or "" for null (clears it). */
export function parseDate(value: string, flag: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (!taskDateSchema.safeParse(v).success) throw usageError(`Invalid date "${value}" in ${flag}. Expected YYYY-MM-DD, or "" to clear it`);
  return v;
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

export { kindOf, matchStatuses };

/** The status a name refers to in the workflow of `kind` (ST-90); a category picks its first status in board order. */
export function resolveStatus(project: ProjectDetailDto, name: string, kind: TaskKind = "task"): StatusDto {
  const status = matchStatuses(project, name, kind)[0];
  if (!status) throw usageError(unknownStatusMessage(project, name, kind));
  return status;
}

/** The first status of a category in the workflow of `kind`, in board order. */
export function firstStatus(project: ProjectDetailDto, category: StatusCategory, kind: TaskKind = "task"): StatusDto {
  const status = firstStatusOf(project, category, kind);
  if (!status) throw usageError(`${project.key}${kind === "task" ? "" : `'s ${kind} workflow`} has no "${category}" status`);
  return status;
}

/** A status to edit (`project status …`): its id or its exact name (any case) in the workflow of `kind`. */
export function findWorkflowStatus(project: ProjectDetailDto, ref: string, kind: TaskKind): StatusDto {
  const statuses = workflowOf(project, kind);
  const status = statuses.find((s) => s.id === ref) ?? statuses.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());
  if (!status) throw usageError(unknownStatusMessage(project, ref, kind));
  return status;
}

/** "task", "release" or "milestone", any case. */
export function parseKind(value: string): TaskKind {
  const kind = TASK_KINDS.find((k) => k === value.trim().toLowerCase());
  if (!kind) throw usageError(`Unknown kind "${value}". Use one of: ${TASK_KINDS.join(", ")}`);
  return kind;
}

/** A status category: "in_progress", "in progress" or "in-progress". */
export function parseCategory(value: string): StatusCategory {
  const parsed = statusCategorySchema.safeParse(value.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  if (!parsed.success) throw usageError(`Unknown category "${value}". Use one of: ${statusCategorySchema.options.join(", ")}`);
  return parsed.data;
}

/** A position in a workflow, from 0. */
export function parsePosition(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw usageError(`Invalid position "${value}". Use 0 for first, 1 for second, …`);
  return Number(value);
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

/**
 * What "mine" stands for, for re-checking a task list on the client: the caller's person (the
 * caller, or an agent caller's owner) and that person's agents, deleted ones included. `actors`
 * is every actor (`members?all=true`), whose `ownerId` says whose each agent is.
 */
export function mineActorIds(me: ActorDto, actors: ActorDto[]): string[] {
  // Servers before ST-78 don't send ownerId. The server has already applied `mine` (ST-76), so
  // the client-side re-check must not narrow further: every actor counts (an agent's owner is an
  // active person, so "agents and deactivated actors" alone would drop the owner's tasks).
  if (!actors.some((a) => "ownerId" in a)) return [...new Set([me.id, ...actors.map((a) => a.id)])];
  const person = me.type === "agent" ? (me.ownerId ?? actors.find((a) => a.id === me.id)?.ownerId ?? me.id) : me.id;
  return [...new Set([person, me.id, ...actors.filter((a) => a.ownerId === person).map((a) => a.id)])];
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
  /** Only this kind; tasks from servers before kinds (ST-90) are ordinary tasks. */
  kind?: TaskKind;
  statusIds?: string[];
  /** Actor ids, or "none" for unassigned. */
  assignee?: string[];
  /** The task must carry all of these (or one of them, with `tagMatch: "any"`). */
  tagIds?: string[];
  tagMatch?: "all" | "any";
  priority?: number[];
  /** Only overdue tasks (see isOverdue): the categories of the project's statuses tell which are closed. */
  overdue?: { statuses: Pick<StatusDto, "id" | "category">[]; today?: string };
}

/**
 * The task list filters, applied again on the client: an API from before ST-50 ignores the
 * query parameters and returns every task, which must not reach an agent picking up work.
 */
export function matchesTaskFilter(
  task: { kind?: TaskKind; statusId: string; assigneeIds: string[]; tagIds?: string[]; priority: number; targetDate?: string | null },
  filter: TaskListFilter,
): boolean {
  if (filter.kind && kindOf(task) !== filter.kind) return false;
  if (filter.statusIds && !filter.statusIds.includes(task.statusId)) return false;
  if (filter.overdue) {
    const category = filter.overdue.statuses.find((s) => s.id === task.statusId)?.category;
    // Servers from before dates (ST-91) send no targetDate: nothing is overdue.
    if (!isOverdue({ targetDate: task.targetDate ?? null }, category, filter.overdue.today)) return false;
  }
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
