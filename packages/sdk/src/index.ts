import type {
  AcceptedAgentInviteDto,
  ActivityDto,
  PresenceDto,
  ActorDto,
  AgentDto,
  BulkUpdateTasksResponse,
  ApiErrorBody,
  CommentDto,
  DeleteStatusResponse,
  AgentInviteDto,
  CreatedAgentInviteDto,
  CreatedApiKeyDto,
  DocumentDiffDto,
  DocumentDto,
  DocumentGraphDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  InboxItemDto,
  InboxKind,
  DeviceCodeResponse,
  DeviceTokenResponse,
  ListResponse,
  MeResponse,
  ProjectDetailDto,
  Priority,
  ProjectDto,
  RelationDto,
  SavedViewDto,
  TagDto,
  SubtaskDto,
  TaskDto,
  TaskKind,
  UpdatedDocumentDto,
  WhoAmIResponse,
} from "@repo/core/contracts";
import type {
  AcceptAgentInviteInput,
  BulkUpdateTasksInput,
  CreateAgentInviteInput,
  CreateAgentInput,
  CreateCommentInput,
  CreateDocumentInput,
  CreateProjectInput,
  CreateSavedViewInput,
  CreateStatusInput,
  CreateTagInput,
  CreateTaskInput,
  MarkDuplicateInput,
  RelationInput,
  UpdateAgentInput,
  UpdateDocumentInput,
  DocumentDiffQuery,
  EditDocumentInput,
  MoveDocumentInput,
  UpdateProjectInput,
  UpdateSavedViewInput,
  UpdateStatusInput,
  UpdateTaskInput,
} from "@repo/core/schemas";

// Typed client for the public API. Imports only the contracts/schemas subpaths
// of @repo/core, so it stays free of the database and runs in browsers too.

/** Filters of `tasks.list` (see `taskListFilters` in @repo/core/schemas). */
export interface TaskListQuery {
  /** Only tasks of this kind (ST-90); status names then match its workflow only. */
  kind?: TaskKind;
  /** Status ids, names or categories. */
  status?: string[];
  /** Actor ids or handles (deactivated ones too), "me", "mine" (the caller's person and their agents) or "none". */
  assignee?: string[];
  /** Tag names, case-insensitive; a task must carry all of them (or any, see `tagMatch`). */
  tags?: string[];
  /** "all" (the server's default) or "any" of `tags`. */
  tagMatch?: "all" | "any";
  priority?: Priority[];
  /** Text in the title. */
  q?: string;
  /** Direct sub-tasks of this task key. */
  parent?: string;
  /** Only tasks past their target date (the server's UTC today) that aren't done or canceled. */
  overdue?: boolean;
}

/** What the client tells the API it is; recorded as the activity source. */
export type ClientSource = "api" | "cli" | "mcp";

export type FetchLike = (input: string, init: RequestInit) => Response | Promise<Response>;

export interface ClientOptions {
  /** API origin, e.g. "https://tracker-api.batele.plus" (without /v1). */
  baseUrl: string;
  /** Agent API key (spt_…). Without one, the browser session cookie is sent. */
  token?: string;
  /** Sent as X-Spider-Source; the API honors it for API-key requests only. */
  source?: ClientSource;
  /** Override the transport, e.g. to call a Hono app in tests. */
  fetch?: FetchLike;
}

export class SpiderApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpiderApiError";
  }
}

export type SpiderClient = ReturnType<typeof createClient>;

/** Result of polling POST /device/token: a token, or an RFC 8628 error code to act on. */
export type DevicePollResult =
  | { ok: true; token: DeviceTokenResponse }
  | { ok: false; error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | "invalid_grant" | string };

export function createClient({ baseUrl, token, source, fetch: transport }: ClientOptions) {
  const origin = baseUrl.replace(/\/+$/, "");
  const send: FetchLike = transport ?? ((input, init) => fetch(input, init));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (source) headers.set("X-Spider-Source", source);

    const res = await send(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Bearer tokens need no cookies; browser sessions do.
      ...(token ? {} : { credentials: "include" }),
    });
    if (!res.ok) {
      const error = (await res.json().catch(() => null)) as ApiErrorBody | null;
      // HTTP/2 has no status text, and proxies answer with HTML: never an empty message.
      throw new SpiderApiError(
        res.status,
        error?.error?.code ?? "unknown",
        error?.error?.message || `${method} ${path} failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** POST /device/token answers 400 with { error } until approved, so it isn't treated as a failure. */
  async function pollDevice(deviceCode: string): Promise<DevicePollResult> {
    const res = await send(`${origin}/device/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }),
    });
    const body = (await res.json().catch(() => null)) as (DeviceTokenResponse & { error?: string }) | null;
    if (res.ok && body?.access_token) return { ok: true, token: body };
    if (res.status === 400 && typeof body?.error === "string") return { ok: false, error: body.error };
    throw new SpiderApiError(res.status, "unknown", res.statusText || "Device login failed");
  }

  const org = (slug: string) => `/v1/orgs/${encodeURIComponent(slug)}`;
  const seg = encodeURIComponent;

  return {
    /** The agent an API key acts as, and its organization. */
    whoami: () => request<WhoAmIResponse>("GET", "/v1/whoami"),
    /** The signed-in person and their organizations (browser sessions only). */
    me: () => request<MeResponse>("GET", "/v1/me"),

    /** `spider login`: RFC 8628 device authorization. */
    device: {
      start: (clientName?: string) =>
        request<DeviceCodeResponse>("POST", "/device/code", clientName ? { client_name: clientName } : {}),
      poll: pollDevice,
    },

    keys: {
      /** Revokes the API key this client authenticates with. */
      revokeCurrent: () => request<void>("DELETE", "/v1/api-keys/current"),
    },

    members: {
      /** Active members; deactivated ones too with `all: true` (they have `deactivated: true`). */
      list: (orgSlug: string, query: { all?: boolean } = {}) =>
        request<ListResponse<ActorDto>>("GET", `${org(orgSlug)}/members${query.all ? "?all=true" : ""}`),
    },

    /** Anyone but guests creates agents; the owner (or an org owner/admin) manages them and their keys. */
    agents: {
      list: (orgSlug: string) => request<ListResponse<AgentDto>>("GET", `${org(orgSlug)}/agents`),
      create: (orgSlug: string, input: CreateAgentInput) => request<AgentDto>("POST", `${org(orgSlug)}/agents`, input),
      update: (orgSlug: string, agentId: string, input: UpdateAgentInput) =>
        request<AgentDto>("PATCH", `${org(orgSlug)}/agents/${seg(agentId)}`, input),
      /** An agent key changes its own name, handle or description. */
      updateMe: (orgSlug: string, input: UpdateAgentInput) => request<AgentDto>("PATCH", `${org(orgSlug)}/agents/me`, input),
      /** Deactivates the agent and revokes all its keys. */
      delete: (orgSlug: string, agentId: string) => request<void>("DELETE", `${org(orgSlug)}/agents/${seg(agentId)}`),
      keys: {
        /** The secret is returned only here. */
        create: (orgSlug: string, agentId: string, input: { name: string }) =>
          request<CreatedApiKeyDto>("POST", `${org(orgSlug)}/agents/${seg(agentId)}/keys`, input),
        revoke: (orgSlug: string, keyId: string) => request<void>("DELETE", `${org(orgSlug)}/api-keys/${seg(keyId)}`),
      },
    },

    /** One-time codes an agent uses to set itself up, limited to some projects. */
    agentInvites: {
      create: (orgSlug: string, input: CreateAgentInviteInput) =>
        request<CreatedAgentInviteDto>("POST", `${org(orgSlug)}/agent-invites`, input),
      list: (orgSlug: string) => request<ListResponse<AgentInviteDto>>("GET", `${org(orgSlug)}/agent-invites`),
      revoke: (orgSlug: string, inviteId: string) => request<void>("DELETE", `${org(orgSlug)}/agent-invites/${seg(inviteId)}`),
      /** No token needed: the code (or invite link) is the credential. Returns the agent's first API key. */
      accept: (input: AcceptAgentInviteInput) => request<AcceptedAgentInviteDto>("POST", "/v1/agent-invites/accept", input),
    },

    /** Owners and admins create, change and archive projects. */
    projects: {
      /** Archived projects only with `archived: true`. */
      list: (orgSlug: string, query: { archived?: boolean } = {}) =>
        request<ListResponse<ProjectDto>>("GET", `${org(orgSlug)}/projects${query.archived ? "?archived=true" : ""}`),
      get: (orgSlug: string, projectKey: string) =>
        request<ProjectDetailDto>("GET", `${org(orgSlug)}/projects/${seg(projectKey)}`),
      create: (orgSlug: string, input: CreateProjectInput) =>
        request<ProjectDetailDto>("POST", `${org(orgSlug)}/projects`, input),
      update: (orgSlug: string, projectKey: string, input: UpdateProjectInput) =>
        request<ProjectDetailDto>("PATCH", `${org(orgSlug)}/projects/${seg(projectKey)}`, input),
      /** Hides it from lists and refuses new tasks; archiving twice changes nothing. */
      archive: (orgSlug: string, projectKey: string) =>
        request<ProjectDetailDto>("POST", `${org(orgSlug)}/projects/${seg(projectKey)}/archive`),
      unarchive: (orgSlug: string, projectKey: string) =>
        request<ProjectDetailDto>("DELETE", `${org(orgSlug)}/projects/${seg(projectKey)}/archive`),
      /** Workflow editing (ST-90, owners, admins and their agents); each answers with the project's workflows. */
      statuses: {
        create: (orgSlug: string, projectKey: string, input: CreateStatusInput) =>
          request<ProjectDetailDto>("POST", `${org(orgSlug)}/projects/${seg(projectKey)}/statuses`, input),
        update: (orgSlug: string, projectKey: string, statusId: string, input: UpdateStatusInput) =>
          request<ProjectDetailDto>("PATCH", `${org(orgSlug)}/projects/${seg(projectKey)}/statuses/${seg(statusId)}`, input),
        /** Moves the status's tasks to `moveTo` (a status of the same workflow), then deletes it. */
        delete: (orgSlug: string, projectKey: string, statusId: string, { moveTo }: { moveTo: string }) =>
          request<DeleteStatusResponse>(
            "DELETE",
            `${org(orgSlug)}/projects/${seg(projectKey)}/statuses/${seg(statusId)}?${new URLSearchParams({ moveTo })}`,
          ),
      },
    },

    views: {
      /** The project's shared views plus the caller's own. */
      list: (orgSlug: string, projectKey: string) =>
        request<ListResponse<SavedViewDto>>("GET", `${org(orgSlug)}/projects/${seg(projectKey)}/views`),
      create: (orgSlug: string, projectKey: string, input: CreateSavedViewInput) =>
        request<SavedViewDto>("POST", `${org(orgSlug)}/projects/${seg(projectKey)}/views`, input),
      update: (orgSlug: string, projectKey: string, viewId: string, input: UpdateSavedViewInput) =>
        request<SavedViewDto>("PATCH", `${org(orgSlug)}/projects/${seg(projectKey)}/views/${seg(viewId)}`, input),
      delete: (orgSlug: string, projectKey: string, viewId: string) =>
        request<void>("DELETE", `${org(orgSlug)}/projects/${seg(projectKey)}/views/${seg(viewId)}`),
    },

    tags: {
      list: (orgSlug: string) => request<ListResponse<TagDto>>("GET", `${org(orgSlug)}/tags`),
      create: (orgSlug: string, input: CreateTagInput) => request<TagDto>("POST", `${org(orgSlug)}/tags`, input),
      delete: (orgSlug: string, tagId: string) => request<void>("DELETE", `${org(orgSlug)}/tags/${seg(tagId)}`),
    },

    comments: {
      list: (orgSlug: string, taskKey: string) =>
        request<ListResponse<CommentDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/comments`),
      create: (orgSlug: string, taskKey: string, input: CreateCommentInput) =>
        request<CommentDto>("POST", `${org(orgSlug)}/tasks/${seg(taskKey)}/comments`, input),
    },

    inbox: {
      /**
       * Oldest first. `after` is a cursor (last id seen); `wait` holds the request up to 25 s for new items.
       * `kinds` defaults to the task kinds; ask for "rules" to get project rules changes too.
       */
      list: (
        orgSlug: string,
        query: { after?: number; unread?: boolean; limit?: number; wait?: number; kinds?: InboxKind[] } = {},
      ) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
        const qs = params.size ? `?${params}` : "";
        return request<ListResponse<InboxItemDto>>("GET", `${org(orgSlug)}/inbox${qs}`);
      },
      markRead: (orgSlug: string, input: { ids?: number[]; upTo?: number }) =>
        request<{ updated: number }>("POST", `${org(orgSlug)}/inbox/read`, input),
    },

    documents: {
      /** Without content, most recently updated first: a task's, a project's (with its tasks'), or the whole organization's. */
      list: (orgSlug: string, query: { project?: string; task?: string } = {}) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
        const qs = params.size ? `?${params}` : "";
        return request<ListResponse<DocumentSummaryDto>>("GET", `${org(orgSlug)}/documents${qs}`);
      },
      get: (orgSlug: string, id: string) => request<DocumentDto>("GET", `${org(orgSlug)}/documents/${seg(id)}`),
      /** Every visible document, the tasks and projects around them, and their links. */
      graph: (orgSlug: string) => request<DocumentGraphDto>("GET", `${org(orgSlug)}/documents/graph`),
      /** Documents linking here with `[[its title]]` or `[[doc:<id>]]`, most recently updated first. */
      backlinks: (orgSlug: string, id: string) =>
        request<ListResponse<DocumentSummaryDto>>("GET", `${org(orgSlug)}/documents/${seg(id)}/backlinks`),
      create: (orgSlug: string, input: CreateDocumentInput) =>
        request<DocumentDto>("POST", `${org(orgSlug)}/documents`, input),
      /**
       * Saves a new version; fails with 409 "conflict" if someone saved since `baseVersion`. A rename
       * rewrites `[[Old title]]` links in the documents linking here and reports them in `relinked`.
       */
      update: (orgSlug: string, id: string, input: UpdateDocumentInput) =>
        request<UpdatedDocumentDto>("PATCH", `${org(orgSlug)}/documents/${seg(id)}`, input),
      /** Partial edits (replace a fragment, append, replace a section), saved as one new version. */
      edit: (orgSlug: string, id: string, input: EditDocumentInput) =>
        request<DocumentDto>("POST", `${org(orgSlug)}/documents/${seg(id)}/edit`, input),
      move: (orgSlug: string, id: string, input: MoveDocumentInput) =>
        request<DocumentDto>("POST", `${org(orgSlug)}/documents/${seg(id)}/move`, input),
      delete: (orgSlug: string, id: string) => request<void>("DELETE", `${org(orgSlug)}/documents/${seg(id)}`),
      versions: {
        list: (orgSlug: string, id: string) =>
          request<ListResponse<DocumentVersionSummaryDto>>("GET", `${org(orgSlug)}/documents/${seg(id)}/versions`),
        get: (orgSlug: string, id: string, version: number) =>
          request<DocumentVersionDto>("GET", `${org(orgSlug)}/documents/${seg(id)}/versions/${version}`),
      },
      /** A line diff of two saved versions; without `to`, against the current one. 404 for a missing version. */
      diff: (orgSlug: string, id: string, { from, to }: DocumentDiffQuery) => {
        const params = new URLSearchParams({ from: String(from) });
        if (to !== undefined) params.set("to", String(to));
        return request<DocumentDiffDto>("GET", `${org(orgSlug)}/documents/${seg(id)}/diff?${params}`);
      },
    },

    tasks: {
      /**
       * In board order. Statuses, assignees and priorities match any of their values; a task must
       * carry every tag (any with `tagMatch: "any"`); filters combine with AND.
       */
      list: (orgSlug: string, projectKey: string, query: TaskListQuery = {}) => {
        const params = new URLSearchParams();
        if (query.kind) params.set("kind", query.kind);
        for (const value of query.status ?? []) params.append("status", value);
        for (const value of query.assignee ?? []) params.append("assignee", value);
        for (const value of query.tags ?? []) params.append("tag", value);
        if (query.tagMatch) params.set("tagMatch", query.tagMatch);
        for (const value of query.priority ?? []) params.append("priority", String(value));
        if (query.q) params.set("q", query.q);
        if (query.parent) params.set("parent", query.parent);
        if (query.overdue !== undefined) params.set("overdue", String(query.overdue));
        const qs = params.size ? `?${params}` : "";
        return request<ListResponse<TaskDto>>("GET", `${org(orgSlug)}/projects/${seg(projectKey)}/tasks${qs}`);
      },
      /** Agents working on the project's tasks right now (acted on or read a task in the last 10 minutes). */
      presence: (orgSlug: string, projectKey: string) =>
        request<ListResponse<PresenceDto>>("GET", `${org(orgSlug)}/projects/${seg(projectKey)}/presence`),
      get: (orgSlug: string, taskKey: string) => request<TaskDto>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}`),
      create: (orgSlug: string, projectKey: string, input: CreateTaskInput) =>
        request<TaskDto>("POST", `${org(orgSlug)}/projects/${seg(projectKey)}/tasks`, input),
      update: (orgSlug: string, taskKey: string, input: UpdateTaskInput) =>
        request<TaskDto>("PATCH", `${org(orgSlug)}/tasks/${seg(taskKey)}`, input),
      /**
       * Several tasks by `keys` or a `filter` (one project), at most 100; one result per task
       * (changed, unchanged or error), and an error on one task doesn't stop the others.
       */
      bulkUpdate: (orgSlug: string, input: BulkUpdateTasksInput) =>
        request<BulkUpdateTasksResponse>("POST", `${org(orgSlug)}/tasks/bulk-update`, input),
      delete: (orgSlug: string, taskKey: string) =>
        request<void>("DELETE", `${org(orgSlug)}/tasks/${seg(taskKey)}`),
      /**
       * Marks the task as a duplicate of `input.of` in one step: the `duplicates` link, the project's first
       * canceled status and a "Duplicate of KEY" comment. A repeat changes nothing.
       */
      markDuplicate: (orgSlug: string, taskKey: string, input: MarkDuplicateInput) =>
        request<TaskDto>("POST", `${org(orgSlug)}/tasks/${seg(taskKey)}/duplicate`, input),
      relations: {
        list: (orgSlug: string, taskKey: string) =>
          request<ListResponse<RelationDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/relations`),
        add: (orgSlug: string, taskKey: string, input: RelationInput) =>
          request<RelationDto>("POST", `${org(orgSlug)}/tasks/${seg(taskKey)}/relations`, input),
        remove: (orgSlug: string, taskKey: string, input: RelationInput) =>
          request<void>(
            "DELETE",
            `${org(orgSlug)}/tasks/${seg(taskKey)}/relations?${new URLSearchParams({ kind: input.kind, task: input.task })}`,
          ),
      },
      /** Documents mentioning the task (`[[ST-12]]` or a plain ST-12), most recently updated first; not its own. */
      backlinks: (orgSlug: string, taskKey: string) =>
        request<ListResponse<DocumentSummaryDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/backlinks`),
      /** Direct sub-tasks, oldest first. */
      subtasks: (orgSlug: string, taskKey: string) =>
        request<ListResponse<SubtaskDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/subtasks`),
      /** The task's history (created, updated fields, comments), oldest first. */
      activity: (orgSlug: string, taskKey: string) =>
        request<ListResponse<ActivityDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/activity`),
    },
  };
}
