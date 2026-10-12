// What the CLI (`--json`) and the MCP server print for tasks, comments and old document versions
// (ST-107): the API DTOs plus names a reader needs (status, handles, tag names), built the same
// way on both sides so scripts can switch between them. Browser-safe: no database imports.

import type {
  ActorDto,
  CommentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  RelationKind,
  StatusDto,
  TagDto,
  TaskDto,
} from "./contracts";

/** A task as the CLI and MCP print it: the API task plus its status, assignee handles and tag names. */
export interface TaskView extends TaskDto {
  /** Null when the status isn't in the project's list (it always is, unless the data changed underfoot). */
  status: Pick<StatusDto, "id" | "name" | "category"> | null;
  /** Handles; deactivated actors as "handle (deactivated)". */
  assignees: string[];
  /** Tag names. */
  tags: string[];
}

/** A link from a task's side, as `task view` and `get_task` list it. */
export interface RelationView {
  kind: RelationKind;
  /** The other task's key. */
  task: string;
  title: string;
}

/** `spider task view --json` and MCP `get_task`: sub-tasks, links and documents replace the sub-task counts. */
export interface TaskDetailView extends Omit<TaskView, "subtasks"> {
  subtasks: TaskView[];
  relations: RelationView[];
  documents: DocumentSummaryDto[];
}

/** A comment with its author's handle. */
export interface CommentView extends CommentDto {
  author: string;
}

/** An older version of a document, with the current document's scope, id and version. */
export interface DocumentVersionView extends DocumentVersionDto {
  id: string;
  projectKey: string | null;
  taskKey: string | null;
  currentVersion: number;
  url?: string;
}

/** The actors a view names: active and deactivated (members `?all=true`). */
export type ActorRef = Pick<ActorDto, "id" | "handle" | "deactivated">;

/** An actor's handle, marked when deactivated; the id when unknown. */
export function actorHandle(actors: ActorRef[], id: string): string {
  const actor = actors.find((a) => a.id === id);
  if (!actor) return id;
  return actor.deactivated ? `${actor.handle} (deactivated)` : actor.handle;
}

export interface TaskViewLookups {
  /** The statuses of the task's project. */
  statuses: Pick<StatusDto, "id" | "name" | "category">[];
  actors: ActorRef[];
  tags: Pick<TagDto, "id" | "name">[];
}

export function taskView(raw: TaskDto, { statuses, actors, tags }: TaskViewLookups): TaskView {
  // Servers from before tags (ST-8) don't send tagIds.
  const task = { ...raw, tagIds: raw.tagIds ?? [] };
  const status = statuses.find((s) => s.id === task.statusId);
  return {
    ...task,
    status: status ? { id: status.id, name: status.name, category: status.category } : null,
    assignees: task.assigneeIds.map((id) => actorHandle(actors, id)),
    tags: task.tagIds.map((id) => tags.find((t) => t.id === id)?.name ?? id),
  };
}

export const relationView = (r: { kind: RelationKind; task: { key: string; title: string } }): RelationView => ({
  kind: r.kind,
  task: r.task.key,
  title: r.task.title,
});

export const commentView = (comment: CommentDto, actors: ActorRef[]): CommentView => ({
  ...comment,
  author: actorHandle(actors, comment.authorId),
});

export function documentVersionView(
  current: Pick<DocumentSummaryDto, "id" | "projectKey" | "taskKey" | "version" | "url">,
  old: DocumentVersionDto,
): DocumentVersionView {
  return {
    ...old,
    id: current.id,
    projectKey: current.projectKey,
    taskKey: current.taskKey,
    currentVersion: current.version,
    ...(current.url ? { url: current.url } : {}),
  };
}
