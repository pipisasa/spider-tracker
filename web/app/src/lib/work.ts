import type {
  ActivityDto,
  ActorDto,
  AgentDto,
  AgentInviteDto,
  CommentDto,
  CreatedAgentInviteDto,
  DocumentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  InvitationDto,
  RelationDto,
  TagDto,
  CreatedApiKeyDto,
  ListResponse,
  ProjectDetailDto,
  ProjectDto,
  SubtaskDto,
  TaskDto,
} from "@repo/core/contracts";
import type {
  CreateAgentInput,
  CreateAgentInviteInput,
  CreateDocumentInput,
  CreateInvitationInput,
  CreateProjectInput,
  CreateTagInput,
  CreateTaskInput,
  UpdateAgentInput,
  UpdateProjectInput,
  UpdateDocumentInput,
  MoveDocumentInput,
  UpdateTaskInput,
} from "@repo/core/schemas";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";

// Queries and mutations for organization-scoped data (projects, tasks, members).

const orgPath = (org: string) => `/v1/orgs/${encodeURIComponent(org)}`;

export const keys = {
  members: (org: string) => ["orgs", org, "members"] as const,
  // Under `members`, so invalidating members refreshes it too.
  actors: (org: string) => ["orgs", org, "members", "all"] as const,
  agents: (org: string) => ["orgs", org, "agents"] as const,
  agentInvites: (org: string) => ["orgs", org, "agent-invites"] as const,
  invitations: (org: string) => ["orgs", org, "invitations"] as const,
  tags: (org: string) => ["orgs", org, "tags"] as const,
  projects: (org: string) => ["orgs", org, "projects"] as const,
  archivedProjects: (org: string) =>
    ["orgs", org, "archived-projects"] as const,
  project: (org: string, key: string) =>
    ["orgs", org, "projects", key] as const,
  tasks: (org: string, key: string) =>
    ["orgs", org, "projects", key, "tasks"] as const,
  task: (org: string, taskKey: string) =>
    ["orgs", org, "tasks", taskKey] as const,
  comments: (org: string, taskKey: string) =>
    ["orgs", org, "tasks", taskKey, "comments"] as const,
  activity: (org: string, taskKey: string) =>
    ["orgs", org, "tasks", taskKey, "activity"] as const,
  subtasks: (org: string, taskKey: string) =>
    ["orgs", org, "tasks", taskKey, "subtasks"] as const,
  relations: (org: string, taskKey: string) =>
    ["orgs", org, "tasks", taskKey, "relations"] as const,
  documentLists: (org: string) => ["orgs", org, "documents", "list"] as const,
  documents: (org: string, scope: DocumentScope) =>
    ["orgs", org, "documents", "list", scope] as const,
  document: (org: string, id: string) =>
    ["orgs", org, "documents", id] as const,
  documentVersions: (org: string, id: string) =>
    ["orgs", org, "documents", id, "versions"] as const,
  documentVersion: (org: string, id: string, version: number) =>
    ["orgs", org, "documents", id, "versions", version] as const,
};

/** Which documents to list: a task's, a project's (with its tasks'), or all. */
export type DocumentScope = { project?: string; task?: string };

export const membersQuery = (org: string) =>
  queryOptions({
    queryKey: keys.members(org),
    queryFn: async () =>
      (await api<ListResponse<ActorDto>>(`${orgPath(org)}/members`)).items,
    staleTime: 60_000,
  });

/** Every actor, deactivated ones included: for naming assignees and authors, never for pickers. */
export const actorsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.actors(org),
    queryFn: async () =>
      (await api<ListResponse<ActorDto>>(`${orgPath(org)}/members?all=true`))
        .items,
    staleTime: 60_000,
  });

export const projectsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.projects(org),
    queryFn: async () =>
      (await api<ListResponse<ProjectDto>>(`${orgPath(org)}/projects`)).items,
  });

export const archivedProjectsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.archivedProjects(org),
    queryFn: async () =>
      (
        await api<ListResponse<ProjectDto>>(
          `${orgPath(org)}/projects?archived=true`,
        )
      ).items.filter((p) => p.archivedAt !== null),
  });

export const projectQuery = (org: string, key: string) =>
  queryOptions({
    queryKey: keys.project(org, key),
    queryFn: () => api<ProjectDetailDto>(`${orgPath(org)}/projects/${key}`),
  });

export const tasksQuery = (org: string, key: string) =>
  queryOptions({
    queryKey: keys.tasks(org, key),
    queryFn: async () =>
      (
        await api<ListResponse<TaskDto>>(
          `${orgPath(org)}/projects/${key}/tasks`,
        )
      ).items,
  });

export const taskQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.task(org, taskKey),
    queryFn: () => api<TaskDto>(`${orgPath(org)}/tasks/${taskKey}`),
  });

const projectKeyOf = (taskKey: string) =>
  taskKey.slice(0, taskKey.lastIndexOf("-"));

export function useCreateProject(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      api<ProjectDetailDto>(`${orgPath(org)}/projects`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (project) => {
      qc.setQueryData(keys.project(org, project.key), project);
      void qc.invalidateQueries({ queryKey: keys.projects(org) });
    },
  });
}

function refreshProjects(qc: ReturnType<typeof useQueryClient>, org: string) {
  void qc.invalidateQueries({ queryKey: keys.projects(org) });
  void qc.invalidateQueries({ queryKey: keys.archivedProjects(org) });
}

export function useUpdateProject(org: string, projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) =>
      api<ProjectDto>(`${orgPath(org)}/projects/${projectKey}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      toast.success("Project updated");
      refreshProjects(qc, org);
    },
    onError: (error) => toast.error(error.message),
  });
}

/** Archive (`archive: true`) or restore (`false`) a project. */
export function useArchiveProject(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, archive }: { key: string; archive: boolean }) =>
      api<ProjectDto>(`${orgPath(org)}/projects/${key}/archive`, {
        method: archive ? "POST" : "DELETE",
      }),
    onSuccess: (project, { archive }) => {
      toast.success(
        archive ? `Archived ${project.name}` : `Restored ${project.name}`,
      );
      refreshProjects(qc, org);
    },
    onError: (error) => toast.error(error.message),
  });
}

/** A parent's sub-task progress is computed by the server; refetch task lists and details when a child changes. */
function refreshProgress(qc: ReturnType<typeof useQueryClient>, org: string) {
  void qc.invalidateQueries({
    predicate: ({ queryKey: k }) =>
      k[0] === "orgs" &&
      k[1] === org &&
      ((k[2] === "projects" && k[4] === "tasks" && k.length === 5) ||
        (k[2] === "tasks" && k.length === 4)),
  });
}

export function useCreateTask(org: string, projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      api<TaskDto>(`${orgPath(org)}/projects/${projectKey}/tasks`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (task) => {
      qc.setQueryData<TaskDto[]>(keys.tasks(org, projectKey), (old) =>
        old ? [...old, task] : old,
      );
      qc.setQueryData(keys.task(org, task.key), task);
      if (task.parentId) refreshProgress(qc, org);
    },
  });
}

/**
 * Updates a task optimistically. `optimistic` is applied to the cached task right away
 * (e.g. a new sortKey for a drag); the server's response replaces it.
 */
export function useUpdateTask(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskKey,
      input,
    }: {
      taskKey: string;
      input: UpdateTaskInput;
      optimistic?: Partial<TaskDto>;
    }) =>
      api<TaskDto>(`${orgPath(org)}/tasks/${taskKey}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onMutate: async ({ taskKey, input, optimistic }) => {
      const listKey = keys.tasks(org, projectKeyOf(taskKey));
      await qc.cancelQueries({ queryKey: listKey });
      const previousList = qc.getQueryData<TaskDto[]>(listKey);
      const previousTask = qc.getQueryData<TaskDto>(keys.task(org, taskKey));

      const { position: _position, ...fields } = input;
      const apply = (t: TaskDto): TaskDto =>
        ({ ...t, ...fields, ...optimistic }) as TaskDto;
      qc.setQueryData<TaskDto[]>(listKey, (old) =>
        old?.map((t) => (t.key === taskKey ? apply(t) : t)),
      );
      qc.setQueryData<TaskDto>(keys.task(org, taskKey), (old) =>
        old ? apply(old) : old,
      );
      return { listKey, previousList, previousTask, taskKey };
    },
    onError: (error, _vars, context) => {
      if (context) {
        qc.setQueryData(context.listKey, context.previousList);
        qc.setQueryData(keys.task(org, context.taskKey), context.previousTask);
      }
      toast.error(error.message);
    },
    onSuccess: (task, { input }) => {
      const listKey = keys.tasks(org, projectKeyOf(task.key));
      qc.setQueryData<TaskDto[]>(listKey, (old) =>
        old?.map((t) => (t.id === task.id ? task : t)),
      );
      qc.setQueryData(keys.task(org, task.key), task);
      if (task.parentId || input.parentId !== undefined) {
        refreshProgress(qc, org);
      }
    },
  });
}

export function useDeleteTask(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskKey: string) =>
      api<void>(`${orgPath(org)}/tasks/${taskKey}`, { method: "DELETE" }),
    onSuccess: (_data, taskKey) => {
      qc.setQueryData<TaskDto[]>(
        keys.tasks(org, projectKeyOf(taskKey)),
        (old) => old?.filter((t) => t.key !== taskKey),
      );
      qc.removeQueries({ queryKey: keys.task(org, taskKey) });
    },
  });
}

export const agentsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.agents(org),
    queryFn: async () =>
      (await api<ListResponse<AgentDto>>(`${orgPath(org)}/agents`)).items,
  });

export function useCreateAgent(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api<AgentDto>(`${orgPath(org)}/agents`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agents(org) });
      void qc.invalidateQueries({ queryKey: keys.members(org) });
    },
  });
}

export function useUpdateAgent(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      input,
    }: {
      agentId: string;
      input: UpdateAgentInput;
    }) =>
      api<AgentDto>(`${orgPath(org)}/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agents(org) });
      void qc.invalidateQueries({ queryKey: keys.members(org) });
    },
  });
}

export function useDeleteAgent(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api<void>(`${orgPath(org)}/agents/${agentId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agents(org) });
      void qc.invalidateQueries({ queryKey: keys.members(org) });
    },
  });
}

export function useCreateApiKey(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, name }: { agentId: string; name: string }) =>
      api<CreatedApiKeyDto>(`${orgPath(org)}/agents/${agentId}/keys`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org) }),
  });
}

export function useRevokeApiKey(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api<void>(`${orgPath(org)}/api-keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org) }),
  });
}

export const agentInvitesQuery = (org: string) =>
  queryOptions({
    queryKey: keys.agentInvites(org),
    queryFn: async () =>
      (await api<ListResponse<AgentInviteDto>>(`${orgPath(org)}/agent-invites`))
        .items,
  });

export function useCreateAgentInvite(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInviteInput) =>
      api<CreatedAgentInviteDto>(`${orgPath(org)}/agent-invites`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: keys.agentInvites(org) }),
  });
}

export function useRevokeAgentInvite(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`${orgPath(org)}/agent-invites/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: keys.agentInvites(org) }),
  });
}

export const invitationsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.invitations(org),
    queryFn: async () =>
      (await api<ListResponse<InvitationDto>>(`${orgPath(org)}/invitations`))
        .items,
  });

export function useCreateInvitation(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvitationInput) =>
      api<InvitationDto>(`${orgPath(org)}/invitations`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: keys.invitations(org) }),
  });
}

export function useRevokeInvitation(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`${orgPath(org)}/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: keys.invitations(org) }),
  });
}

export const commentsQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.comments(org, taskKey),
    queryFn: async () =>
      (
        await api<ListResponse<CommentDto>>(
          `${orgPath(org)}/tasks/${taskKey}/comments`,
        )
      ).items,
  });

export function useAddComment(org: string, taskKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; parentId?: string }) =>
      api<CommentDto>(`${orgPath(org)}/tasks/${taskKey}/comments`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (comment) =>
      qc.setQueryData<CommentDto[]>(keys.comments(org, taskKey), (old) =>
        old ? [...old, comment] : [comment],
      ),
  });
}

export const activityQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.activity(org, taskKey),
    queryFn: async () =>
      (
        await api<ListResponse<ActivityDto>>(
          `${orgPath(org)}/tasks/${taskKey}/activity`,
        )
      ).items,
  });

export const tagsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.tags(org),
    queryFn: async () =>
      (await api<ListResponse<TagDto>>(`${orgPath(org)}/tags`)).items,
    staleTime: 60_000,
  });

export function useCreateTag(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTagInput) =>
      api<TagDto>(`${orgPath(org)}/tags`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (tag) =>
      qc.setQueryData<TagDto[]>(keys.tags(org), (old) =>
        [...(old ?? []), tag].sort((a, b) => a.name.localeCompare(b.name)),
      ),
  });
}

export const subtasksQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.subtasks(org, taskKey),
    queryFn: async () =>
      (
        await api<ListResponse<SubtaskDto>>(
          `${orgPath(org)}/tasks/${taskKey}/subtasks`,
        )
      ).items,
  });

export const relationsQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.relations(org, taskKey),
    queryFn: async () =>
      (
        await api<ListResponse<RelationDto>>(
          `${orgPath(org)}/tasks/${taskKey}/relations`,
        )
      ).items,
  });

export function useRelation(org: string, taskKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      add,
      kind,
      task,
    }: {
      add: boolean;
      kind: RelationDto["kind"];
      task: string;
    }) => {
      if (add) {
        await api<RelationDto>(`${orgPath(org)}/tasks/${taskKey}/relations`, {
          method: "POST",
          body: JSON.stringify({ kind, task }),
        });
      } else {
        await api<void>(
          `${orgPath(org)}/tasks/${taskKey}/relations?${new URLSearchParams({ kind, task })}`,
          { method: "DELETE" },
        );
      }
    },
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: keys.relations(org, taskKey) }),
  });
}

export const documentsQuery = (org: string, scope: DocumentScope = {}) =>
  queryOptions({
    queryKey: keys.documents(org, scope),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (scope.project) params.set("project", scope.project);
      if (scope.task) params.set("task", scope.task);
      const qs = params.size ? `?${params}` : "";
      return (
        await api<ListResponse<DocumentSummaryDto>>(
          `${orgPath(org)}/documents${qs}`,
        )
      ).items;
    },
  });

export const documentQuery = (org: string, id: string) =>
  queryOptions({
    queryKey: keys.document(org, id),
    queryFn: () => api<DocumentDto>(`${orgPath(org)}/documents/${id}`),
  });

export const documentVersionsQuery = (org: string, id: string) =>
  queryOptions({
    queryKey: keys.documentVersions(org, id),
    queryFn: async () =>
      (
        await api<ListResponse<DocumentVersionSummaryDto>>(
          `${orgPath(org)}/documents/${id}/versions`,
        )
      ).items,
  });

export const documentVersionQuery = (
  org: string,
  id: string,
  version: number,
) =>
  queryOptions({
    queryKey: keys.documentVersion(org, id, version),
    queryFn: () =>
      api<DocumentVersionDto>(
        `${orgPath(org)}/documents/${id}/versions/${version}`,
      ),
    // A saved version never changes.
    staleTime: Infinity,
  });

export function useCreateDocument(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocumentInput) =>
      api<DocumentDto>(`${orgPath(org)}/documents`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (document) => {
      qc.setQueryData(keys.document(org, document.id), document);
      void qc.invalidateQueries({ queryKey: keys.documentLists(org) });
    },
  });
}

/** Saves a new version; fails with ApiError 409 when someone saved since `baseVersion`. */
export function useUpdateDocument(org: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDocumentInput) =>
      api<DocumentDto>(`${orgPath(org)}/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: (document) => {
      qc.setQueryData(keys.document(org, id), document);
      void qc.invalidateQueries({ queryKey: keys.documentVersions(org, id) });
      void qc.invalidateQueries({ queryKey: keys.documentLists(org) });
    },
  });
}

/** Moves a document to a project, or to the organization (`project: null`); id and versions stay. */
export function useMoveDocument(org: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MoveDocumentInput) =>
      api<DocumentDto>(`${orgPath(org)}/documents/${id}/move`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (document) => {
      qc.setQueryData(keys.document(org, id), document);
      void qc.invalidateQueries({ queryKey: keys.documentLists(org) });
    },
  });
}

export function useDeleteDocument(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`${orgPath(org)}/documents/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: keys.document(org, id) });
      void qc.invalidateQueries({ queryKey: keys.documentLists(org) });
    },
  });
}
