// What the CLI (`--json`) and the MCP server print for tasks, comments, document comments, versions and diffs
// (ST-107): the API DTOs plus names a reader needs (status, handles, tag names), built the same
// way on both sides so scripts can switch between them. Browser-safe: no database imports.

import { formatUnifiedDiff } from "./diff";
import type {
  ActorDto,
  CommentDto,
  DocumentCommentDto,
  DocumentDiffDto,
  DocumentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  ProjectDto,
  ProjectRulesDto,
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

/** A comment on a document (ST-118) with its author's handle, and the resolver's when resolved. */
export interface DocumentCommentView extends DocumentCommentDto {
  author: string;
  resolver: string | null;
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

export const documentCommentView = (comment: DocumentCommentDto, actors: ActorRef[]): DocumentCommentView => ({
  ...comment,
  author: actorHandle(actors, comment.authorId),
  resolver: comment.resolvedBy ? actorHandle(actors, comment.resolvedBy) : null,
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

/** A document diff (ST-117) with its hunks also as unified diff text (`--- v1` / `+++ v2`; empty when the contents match). */
export interface DocumentDiffView extends DocumentDiffDto {
  diff: string;
}

export const documentDiffView = (dto: DocumentDiffDto): DocumentDiffView => ({
  ...dto,
  diff: formatUnifiedDiff(dto.hunks, `v${dto.from.version}`, `v${dto.to.version}`),
});

/** A project's rules (ST-111) from the project and its rules document, as the API's ProjectRulesDto. */
export const projectRulesView = (
  project: Pick<ProjectDto, "key" | "name">,
  document: Pick<DocumentDto, "id" | "title" | "format" | "version" | "updatedAt" | "content" | "url">,
): ProjectRulesDto & { url?: string } => ({
  projectKey: project.key,
  projectName: project.name,
  documentId: document.id,
  title: document.title,
  format: document.format,
  version: document.version,
  updatedAt: document.updatedAt,
  content: document.content,
  ...(document.url ? { url: document.url } : {}),
});
