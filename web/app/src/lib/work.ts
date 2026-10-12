import type {
  ActivityDto,
  ActorDto,
  AgentDto,
  AgentInviteDto,
  CommentDto,
  CreatedAgentInviteDto,
  DocumentCommentDto,
  DocumentDiffDto,
  DocumentDto,
  DocumentGraphDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  InvitationDto,
  PresenceDto,
  RelationDto,
  ReleaseDto,
  AppDto,
  GithubInstallationDto,
  GithubInstallUrlDto,
  GithubStatusDto,
  RepoDto,
  TagDto,
  CreatedApiKeyDto,
  DeleteStatusResponse,
  ListResponse,
  ProjectDetailDto,
  ProjectDto,
  SavedViewDto,
  SubtaskDto,
  TaskDto,
  UpdatedDocumentDto,
} from "@repo/core/contracts";
import type {
  CreateAgentInput,
  CreateAgentInviteInput,
  CreateDocumentCommentInput,
  CreateDocumentInput,
  CreateInvitationInput,
  CreateProjectInput,
  CreateSavedViewInput,
  CreateTagInput,
  CreateStatusInput,
  CreateAppInput,
  CreateRepoInput,
  UpdateAppInput,
  UpdateRepoInput,
  CreateTaskInput,
  MarkDuplicateInput,
  UpdateAgentInput,
  UpdateProjectInput,
  UpdateSavedViewInput,
  UpdateStatusInput,
  UpdateDocumentInput,
  MoveDocumentInput,
  UpdateTaskInput,
  CreateReleaseInput,
  UpdateReleaseInput,
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
  repos: (org: string) => ["orgs", org, "repos"] as const,
  github: (org: string) => ["orgs", org, "github"] as const,
  projects: (org: string) => ["orgs", org, "projects"] as const,
  archivedProjects: (org: string) =>
    ["orgs", org, "archived-projects"] as const,
  project: (org: string, key: string) =>
    ["orgs", org, "projects", key] as const,
  tasks: (org: string, key: string) =>
    ["orgs", org, "projects", key, "tasks"] as const,
  presence: (org: string, key: string) =>
    ["orgs", org, "projects", key, "presence"] as const,
  views: (org: string, key: string) =>
    ["orgs", org, "projects", key, "views"] as const,
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
  // Under "list", so every document change refreshes them too.
  documentGraph: (org: string) =>
    ["orgs", org, "documents", "list", "graph"] as const,
  documentBacklinks: (org: string, id: string) =>
    ["orgs", org, "documents", "list", "backlinks", id] as const,
  taskBacklinks: (org: string, taskKey: string) =>
    ["orgs", org, "documents", "list", "task-backlinks", taskKey] as const,
  // Under the document, so a new version refreshes them too (their `outdated` marks).
  documentComments: (org: string, id: string) =>
    ["orgs", org, "documents", id, "comments"] as const,
  documentVersions: (org: string, id: string) =>
    ["orgs", org, "documents", id, "versions"] as const,
  documentVersion: (org: string, id: string, version: number) =>
    ["orgs", org, "documents", id, "versions", version] as const,
  documentDiff: (org: string, id: string, from: number, to: number) =>
    ["orgs", org, "documents", id, "diff", from, to] as const,
  // Releases (ST-93): every task change can change them, so all live under one prefix.
  releaseLists: (org: string) => ["orgs", org, "releases"] as const,
  releases: (org: string, projectKey: string) =>
    ["orgs", org, "releases", "project", projectKey] as const,
  release: (org: string, releaseKey: string) =>
    ["orgs", org, "releases", "one", releaseKey] as const,
  releaseCandidates: (org: string, projectKey?: string) =>
    ["orgs", org, "releases", "candidates", projectKey ?? null] as const,
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

/** Agents working on the project's tasks (refreshed by `presence` events; the client expires entries itself). */
export const presenceQuery = (org: string, key: string) =>
  queryOptions({
    queryKey: keys.presence(org, key),
    queryFn: async () =>
      (
        await api<ListResponse<PresenceDto>>(
          `${orgPath(org)}/projects/${key}/presence`,
        )
      ).items,
    staleTime: 30_000,
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

/** Workflow editing (ST-90): add, change (rename, recolor, move) and delete statuses of a project. */
export function useWorkflowMutations(org: string, projectKey: string) {
  const qc = useQueryClient();
  const path = `${orgPath(org)}/projects/${projectKey}/statuses`;
  const done = (project: ProjectDetailDto) => {
    qc.setQueryData(keys.project(org, projectKey), project);
    refreshProjects(qc, org);
  };
  const onError = (error: Error) => toast.error(error.message);
  return {
    create: useMutation({
      mutationFn: (input: CreateStatusInput) => api<ProjectDetailDto>(path, { method: "POST", body: JSON.stringify(input) }),
      onSuccess: done,
      onError,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: UpdateStatusInput & { id: string }) =>
        api<ProjectDetailDto>(`${path}/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
      onSuccess: done,
      onError,
    }),
    remove: useMutation({
      mutationFn: ({ id, moveTo }: { id: string; moveTo: string }) =>
        api<DeleteStatusResponse>(`${path}/${id}?${new URLSearchParams({ moveTo })}`, { method: "DELETE" }),
      onSuccess: (result) => {
        toast.success(`Status deleted; ${result.movedTasks} task${result.movedTasks === 1 ? "" : "s"} moved`);
        done(result.project);
      },
      onError,
    }),
  };
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
      // A release's status ships (or unships) its tasks; a task's status or no-code mark moves it among candidates (ST-93).
      void qc.invalidateQueries({ queryKey: keys.releaseLists(org) });
      if (task.kind === "release" && input.statusId !== undefined) {
        void qc.invalidateQueries({ queryKey: ["orgs", org, "projects"] });
        void qc.invalidateQueries({ queryKey: ["orgs", org, "tasks"] });
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

/** Links as a duplicate, cancels and comments in one call (ST-114); refreshes the task, its links and comments. */
export function useMarkDuplicate(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, input }: { taskKey: string; input: MarkDuplicateInput }) =>
      api<TaskDto>(`${orgPath(org)}/tasks/${taskKey}/duplicate`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (task, { input }) => {
      qc.setQueryData<TaskDto[]>(keys.tasks(org, projectKeyOf(task.key)), (old) =>
        old?.map((t) => (t.id === task.id ? task : t)),
      );
      qc.setQueryData(keys.task(org, task.key), task);
      // The task's comments, links and activity, and the original's links.
      void qc.invalidateQueries({ queryKey: keys.task(org, task.key), predicate: (q) => q.queryKey.length > 4 });
      void qc.invalidateQueries({ queryKey: keys.relations(org, input.of.toUpperCase()) });
      if (task.parentId) refreshProgress(qc, org);
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

/** Documents, the tasks and projects around them, and their links (ST-100). */
export const documentGraphQuery = (org: string) =>
  queryOptions({
    queryKey: keys.documentGraph(org),
    queryFn: () => api<DocumentGraphDto>(`${orgPath(org)}/documents/graph`),
  });

/** Documents linking to this one with `[[its title]]`. */
export const documentBacklinksQuery = (org: string, id: string) =>
  queryOptions({
    queryKey: keys.documentBacklinks(org, id),
    queryFn: async () =>
      (
        await api<ListResponse<DocumentSummaryDto>>(
          `${orgPath(org)}/documents/${id}/backlinks`,
        )
      ).items,
  });

/** Documents mentioning a task: `[[ST-12]]` or a plain ST-12; not its own (ST-101). */
export const taskBacklinksQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.taskBacklinks(org, taskKey),
    queryFn: async () =>
      (
        await api<ListResponse<DocumentSummaryDto>>(
          `${orgPath(org)}/tasks/${taskKey}/backlinks`,
        )
      ).items,
  });

/** Comments on a document (ST-118), oldest first. */
export const documentCommentsQuery = (org: string, id: string) =>
  queryOptions({
    queryKey: keys.documentComments(org, id),
    queryFn: async () =>
      (
        await api<ListResponse<DocumentCommentDto>>(
          `${orgPath(org)}/documents/${id}/comments`,
        )
      ).items,
  });

export function useAddDocumentComment(org: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocumentCommentInput) =>
      api<DocumentCommentDto>(`${orgPath(org)}/documents/${id}/comments`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (comment) =>
      qc.setQueryData<DocumentCommentDto[]>(
        keys.documentComments(org, id),
        (old) => (old ? [...old, comment] : [comment]),
      ),
  });
}

/** Resolves or reopens a thread (its first comment). */
export function useResolveDocumentComment(org: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
      api<DocumentCommentDto>(
        `${orgPath(org)}/documents/${id}/comments/${commentId}`,
        { method: "PATCH", body: JSON.stringify({ resolved }) },
      ),
    onSuccess: (comment) =>
      qc.setQueryData<DocumentCommentDto[]>(
        keys.documentComments(org, id),
        (old) => old?.map((c) => (c.id === comment.id ? comment : c)),
      ),
  });
}

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

/** A line diff of two saved versions (ST-117). */
export const documentDiffQuery = (
  org: string,
  id: string,
  from: number,
  to: number,
) =>
  queryOptions({
    queryKey: keys.documentDiff(org, id, from, to),
    queryFn: () =>
      api<DocumentDiffDto>(
        `${orgPath(org)}/documents/${id}/diff?from=${from}&to=${to}`,
      ),
    // Saved versions never change, so neither does their diff.
    staleTime: Infinity,
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
      api<UpdatedDocumentDto>(`${orgPath(org)}/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: ({ relinked, ...document }) => {
      qc.setQueryData(keys.document(org, id), document);
      void qc.invalidateQueries({ queryKey: keys.documentVersions(org, id) });
      void qc.invalidateQueries({ queryKey: keys.documentLists(org) });
      // A rename rewrote [[links]] in these (ST-101).
      for (const d of relinked?.rewritten ?? [])
        void qc.invalidateQueries({ queryKey: keys.document(org, d.id) });
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

export const viewsQuery = (org: string, projectKey: string) =>
  queryOptions({
    queryKey: keys.views(org, projectKey),
    queryFn: async () =>
      (
        await api<ListResponse<SavedViewDto>>(
          `${orgPath(org)}/projects/${encodeURIComponent(projectKey)}/views`,
        )
      ).items,
  });

export function useCreateView(org: string, projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSavedViewInput) =>
      api<SavedViewDto>(
        `${orgPath(org)}/projects/${encodeURIComponent(projectKey)}/views`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: keys.views(org, projectKey) }),
  });
}

export function useUpdateView(org: string, projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateSavedViewInput & { id: string }) =>
      api<SavedViewDto>(
        `${orgPath(org)}/projects/${encodeURIComponent(projectKey)}/views/${id}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: keys.views(org, projectKey) }),
  });
}

export function useDeleteView(org: string, projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(
        `${orgPath(org)}/projects/${encodeURIComponent(projectKey)}/views/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: keys.views(org, projectKey) }),
  });
}

// Repos and apps (ST-92). A repo is addressed as /repos/:owner/:name.

const repoPath = (org: string, repo: Pick<RepoDto, "owner" | "name">) =>
  `${orgPath(org)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export const reposQuery = (org: string) =>
  queryOptions({
    queryKey: keys.repos(org),
    queryFn: async () =>
      (await api<ListResponse<RepoDto>>(`${orgPath(org)}/repos`)).items,
  });

/** Any repo or app change: the API answers with the repo or app; the list is refetched. */
function useRepoMutation<TInput, TResult>(
  org: string,
  mutationFn: (input: TInput) => Promise<TResult>,
  success: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      toast.success(success);
      void qc.invalidateQueries({ queryKey: keys.repos(org) });
    },
    onError: (error) => toast.error(error.message),
  });
}

export const useCreateRepo = (org: string) =>
  useRepoMutation(
    org,
    (input: CreateRepoInput) =>
      api<RepoDto>(`${orgPath(org)}/repos`, { method: "POST", body: JSON.stringify(input) }),
    "Repo added",
  );

export const useUpdateRepo = (org: string) =>
  useRepoMutation(
    org,
    ({ repo, input }: { repo: RepoDto; input: UpdateRepoInput }) =>
      api<RepoDto>(repoPath(org, repo), { method: "PATCH", body: JSON.stringify(input) }),
    "Repo updated",
  );

export const useDeleteRepo = (org: string) =>
  useRepoMutation(
    org,
    (repo: RepoDto) => api<void>(repoPath(org, repo), { method: "DELETE" }),
    "Repo removed",
  );

/** Attach (`attach: true`) a repo to a project, or detach it. */
export const useAttachRepo = (org: string) =>
  useRepoMutation(
    org,
    ({ repo, project, attach }: { repo: RepoDto; project: string; attach: boolean }) =>
      attach
        ? api<RepoDto>(`${orgPath(org)}/projects/${encodeURIComponent(project)}/repos`, {
            method: "POST",
            body: JSON.stringify({ repo: repo.fullName }),
          })
        : api<RepoDto>(
            `${orgPath(org)}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
            { method: "DELETE" },
          ),
    "Projects updated",
  );

export const useCreateApp = (org: string) =>
  useRepoMutation(
    org,
    ({ repo, input }: { repo: RepoDto; input: CreateAppInput }) =>
      api<AppDto>(`${repoPath(org, repo)}/apps`, { method: "POST", body: JSON.stringify(input) }),
    "App added",
  );

export const useUpdateApp = (org: string) =>
  useRepoMutation(
    org,
    ({ repo, app, input }: { repo: RepoDto; app: string; input: UpdateAppInput }) =>
      api<AppDto>(`${repoPath(org, repo)}/apps/${encodeURIComponent(app)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    "App updated",
  );

export const useDeleteApp = (org: string) =>
  useRepoMutation(
    org,
    ({ repo, app }: { repo: RepoDto; app: string }) =>
      api<void>(`${repoPath(org, repo)}/apps/${encodeURIComponent(app)}`, { method: "DELETE" }),
    "App removed",
  );

// Releases (ST-93): tasks of kind "release" with repos, apps and versions, and included Done tasks.

export const releasesQuery = (org: string, projectKey: string) =>
  queryOptions({
    queryKey: keys.releases(org, projectKey),
    queryFn: async () =>
      (await api<ListResponse<ReleaseDto>>(`${orgPath(org)}/projects/${encodeURIComponent(projectKey)}/releases`)).items,
  });

export const releaseQuery = (org: string, releaseKey: string) =>
  queryOptions({
    queryKey: keys.release(org, releaseKey),
    queryFn: () => api<ReleaseDto>(`${orgPath(org)}/releases/${encodeURIComponent(releaseKey)}`),
  });

/** Done tasks with code in no release; of one project, or every project the viewer can see. */
export const releaseCandidatesQuery = (org: string, projectKey?: string) =>
  queryOptions({
    queryKey: keys.releaseCandidates(org, projectKey),
    queryFn: async () =>
      (
        await api<ListResponse<TaskDto>>(
          `${orgPath(org)}/release-candidates${projectKey ? `?${new URLSearchParams({ project: projectKey })}` : ""}`,
        )
      ).items,
  });

/** A release change: releases and the changed tasks are refetched (shipping states move). */
function useReleaseMutation<TInput>(org: string, mutationFn: (input: TInput) => Promise<ReleaseDto>, success?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (release) => {
      if (success) toast.success(success);
      qc.setQueryData(keys.release(org, release.key), release);
      void qc.invalidateQueries({ queryKey: keys.releaseLists(org) });
      void qc.invalidateQueries({ queryKey: ["orgs", org, "projects"] });
      void qc.invalidateQueries({ queryKey: ["orgs", org, "tasks"] });
    },
    onError: (error) => toast.error(error.message),
  });
}

// The GitHub App (ST-82): Settings → GitHub. Connecting leaves the app for GitHub, which returns
// through the API's /github/setup to the settings page.

export const githubQuery = (org: string) =>
  queryOptions({
    queryKey: keys.github(org),
    queryFn: () => api<GithubStatusDto>(`${orgPath(org)}/github`),
  });

/** Starts the install flow: the page to send the browser to. */
export function useStartGithubInstall(org: string) {
  return useMutation({
    mutationFn: () => api<GithubInstallUrlDto>(`${orgPath(org)}/github/install`, { method: "POST" }),
    onError: (error) => toast.error(error.message),
  });
}

/** Installation changes also change repos (attached, added, released). */
function useGithubMutation<TInput, TResult>(
  org: string,
  mutationFn: (input: TInput) => Promise<TResult>,
  success: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      toast.success(success);
      void qc.invalidateQueries({ queryKey: keys.github(org) });
      void qc.invalidateQueries({ queryKey: keys.repos(org) });
    },
    onError: (error) => toast.error(error.message),
  });
}

export const useCreateRelease = (org: string, projectKey: string) =>
  useReleaseMutation(
    org,
    (input: CreateReleaseInput) =>
      api<ReleaseDto>(`${orgPath(org)}/projects/${encodeURIComponent(projectKey)}/releases`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    "Release created",
  );

export const useUpdateRelease = (org: string) =>
  useReleaseMutation(org, ({ releaseKey, input }: { releaseKey: string; input: UpdateReleaseInput }) =>
    api<ReleaseDto>(`${orgPath(org)}/releases/${encodeURIComponent(releaseKey)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );

export const useAddToRelease = (org: string) =>
  useReleaseMutation(org, ({ releaseKey, taskKeys }: { releaseKey: string; taskKeys: string[] }) =>
    api<ReleaseDto>(`${orgPath(org)}/releases/${encodeURIComponent(releaseKey)}/tasks`, {
      method: "POST",
      body: JSON.stringify({ tasks: taskKeys }),
    }),
  );

export const useRemoveFromRelease = (org: string) =>
  useReleaseMutation(org, ({ releaseKey, taskKey }: { releaseKey: string; taskKey: string }) =>
    api<ReleaseDto>(
      `${orgPath(org)}/releases/${encodeURIComponent(releaseKey)}/tasks/${encodeURIComponent(taskKey)}`,
      { method: "DELETE" },
    ),
  );

export const useSyncGithubInstallation = (org: string) =>
  useGithubMutation(
    org,
    (id: number) =>
      api<GithubInstallationDto>(`${orgPath(org)}/github/installations/${id}/sync`, { method: "POST" }),
    "Synced with GitHub",
  );

export const useDisconnectGithubInstallation = (org: string) =>
  useGithubMutation(
    org,
    (id: number) => api<void>(`${orgPath(org)}/github/installations/${id}`, { method: "DELETE" }),
    "GitHub disconnected",
  );
