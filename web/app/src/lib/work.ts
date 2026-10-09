import type {
  ActorDto,
  AgentDto,
  CreatedApiKeyDto,
  ListResponse,
  ProjectDetailDto,
  ProjectDto,
  TaskDto,
} from "@repo/core/contracts";
import type { CreateAgentInput, CreateProjectInput, CreateTaskInput, UpdateTaskInput } from "@repo/core/schemas";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";

// Queries and mutations for organization-scoped data (projects, tasks, members).

const orgPath = (org: string) => `/v1/orgs/${encodeURIComponent(org)}`;

export const keys = {
  members: (org: string) => ["orgs", org, "members"] as const,
  agents: (org: string) => ["orgs", org, "agents"] as const,
  projects: (org: string) => ["orgs", org, "projects"] as const,
  project: (org: string, key: string) => ["orgs", org, "projects", key] as const,
  tasks: (org: string, key: string) => ["orgs", org, "projects", key, "tasks"] as const,
  task: (org: string, taskKey: string) => ["orgs", org, "tasks", taskKey] as const,
};

export const membersQuery = (org: string) =>
  queryOptions({
    queryKey: keys.members(org),
    queryFn: async () => (await api<ListResponse<ActorDto>>(`${orgPath(org)}/members`)).items,
    staleTime: 60_000,
  });

export const projectsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.projects(org),
    queryFn: async () => (await api<ListResponse<ProjectDto>>(`${orgPath(org)}/projects`)).items,
  });

export const projectQuery = (org: string, key: string) =>
  queryOptions({
    queryKey: keys.project(org, key),
    queryFn: () => api<ProjectDetailDto>(`${orgPath(org)}/projects/${key}`),
  });

export const tasksQuery = (org: string, key: string) =>
  queryOptions({
    queryKey: keys.tasks(org, key),
    queryFn: async () => (await api<ListResponse<TaskDto>>(`${orgPath(org)}/projects/${key}/tasks`)).items,
  });

export const taskQuery = (org: string, taskKey: string) =>
  queryOptions({
    queryKey: keys.task(org, taskKey),
    queryFn: () => api<TaskDto>(`${orgPath(org)}/tasks/${taskKey}`),
  });

const projectKeyOf = (taskKey: string) => taskKey.slice(0, taskKey.lastIndexOf("-"));

export function useCreateProject(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      api<ProjectDetailDto>(`${orgPath(org)}/projects`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (project) => {
      qc.setQueryData(keys.project(org, project.key), project);
      void qc.invalidateQueries({ queryKey: keys.projects(org) });
    },
  });
}

export function useCreateTask(org: string, projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      api<TaskDto>(`${orgPath(org)}/projects/${projectKey}/tasks`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (task) => {
      qc.setQueryData<TaskDto[]>(keys.tasks(org, projectKey), (old) => (old ? [...old, task] : old));
      qc.setQueryData(keys.task(org, task.key), task);
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
    mutationFn: ({ taskKey, input }: { taskKey: string; input: UpdateTaskInput; optimistic?: Partial<TaskDto> }) =>
      api<TaskDto>(`${orgPath(org)}/tasks/${taskKey}`, { method: "PATCH", body: JSON.stringify(input) }),
    onMutate: async ({ taskKey, input, optimistic }) => {
      const listKey = keys.tasks(org, projectKeyOf(taskKey));
      await qc.cancelQueries({ queryKey: listKey });
      const previousList = qc.getQueryData<TaskDto[]>(listKey);
      const previousTask = qc.getQueryData<TaskDto>(keys.task(org, taskKey));

      const { position: _position, ...fields } = input;
      const apply = (t: TaskDto): TaskDto => ({ ...t, ...fields, ...optimistic }) as TaskDto;
      qc.setQueryData<TaskDto[]>(listKey, (old) => old?.map((t) => (t.key === taskKey ? apply(t) : t)));
      qc.setQueryData<TaskDto>(keys.task(org, taskKey), (old) => (old ? apply(old) : old));
      return { listKey, previousList, previousTask, taskKey };
    },
    onError: (error, _vars, context) => {
      if (context) {
        qc.setQueryData(context.listKey, context.previousList);
        qc.setQueryData(keys.task(org, context.taskKey), context.previousTask);
      }
      toast.error(error.message);
    },
    onSuccess: (task) => {
      const listKey = keys.tasks(org, projectKeyOf(task.key));
      qc.setQueryData<TaskDto[]>(listKey, (old) => old?.map((t) => (t.id === task.id ? task : t)));
      qc.setQueryData(keys.task(org, task.key), task);
    },
  });
}

export function useDeleteTask(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskKey: string) => api<void>(`${orgPath(org)}/tasks/${taskKey}`, { method: "DELETE" }),
    onSuccess: (_data, taskKey) => {
      qc.setQueryData<TaskDto[]>(keys.tasks(org, projectKeyOf(taskKey)), (old) =>
        old?.filter((t) => t.key !== taskKey),
      );
      qc.removeQueries({ queryKey: keys.task(org, taskKey) });
    },
  });
}

export const agentsQuery = (org: string) =>
  queryOptions({
    queryKey: keys.agents(org),
    queryFn: async () => (await api<ListResponse<AgentDto>>(`${orgPath(org)}/agents`)).items,
  });

export function useCreateAgent(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api<AgentDto>(`${orgPath(org)}/agents`, { method: "POST", body: JSON.stringify(input) }),
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
      api<CreatedApiKeyDto>(`${orgPath(org)}/agents/${agentId}/keys`, { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org) }),
  });
}

export function useRevokeApiKey(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => api<void>(`${orgPath(org)}/api-keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org) }),
  });
}
