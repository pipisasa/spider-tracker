import type {
  AcceptedAgentInviteDto,
  ActivityDto,
  ActorDto,
  AgentDto,
  ApiErrorBody,
  CommentDto,
  AgentInviteDto,
  CreatedAgentInviteDto,
  CreatedApiKeyDto,
  DocumentDto,
  DocumentSummaryDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  InboxItemDto,
  DeviceCodeResponse,
  DeviceTokenResponse,
  ListResponse,
  MeResponse,
  ProjectDetailDto,
  ProjectDto,
  RelationDto,
  TagDto,
  TaskDto,
  WhoAmIResponse,
} from "@repo/core/contracts";
import type {
  AcceptAgentInviteInput,
  CreateAgentInviteInput,
  CreateAgentInput,
  CreateCommentInput,
  CreateDocumentInput,
  CreateProjectInput,
  CreateTagInput,
  CreateTaskInput,
  RelationInput,
  UpdateAgentInput,
  UpdateDocumentInput,
  MoveDocumentInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@repo/core/schemas";

// Typed client for the public API. Imports only the contracts/schemas subpaths
// of @repo/core, so it stays free of the database and runs in browsers too.

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
      throw new SpiderApiError(res.status, error?.error?.code ?? "unknown", error?.error?.message ?? res.statusText);
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
      /** Oldest first. `after` is a cursor (last id seen); `wait` holds the request up to 25 s for new items. */
      list: (orgSlug: string, query: { after?: number; unread?: boolean; limit?: number; wait?: number } = {}) => {
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
      create: (orgSlug: string, input: CreateDocumentInput) =>
        request<DocumentDto>("POST", `${org(orgSlug)}/documents`, input),
      /** Saves a new version; fails with 409 "conflict" if someone saved since `baseVersion`. */
      update: (orgSlug: string, id: string, input: UpdateDocumentInput) =>
        request<DocumentDto>("PATCH", `${org(orgSlug)}/documents/${seg(id)}`, input),
      move: (orgSlug: string, id: string, input: MoveDocumentInput) =>
        request<DocumentDto>("POST", `${org(orgSlug)}/documents/${seg(id)}/move`, input),
      delete: (orgSlug: string, id: string) => request<void>("DELETE", `${org(orgSlug)}/documents/${seg(id)}`),
      versions: {
        list: (orgSlug: string, id: string) =>
          request<ListResponse<DocumentVersionSummaryDto>>("GET", `${org(orgSlug)}/documents/${seg(id)}/versions`),
        get: (orgSlug: string, id: string, version: number) =>
          request<DocumentVersionDto>("GET", `${org(orgSlug)}/documents/${seg(id)}/versions/${version}`),
      },
    },

    tasks: {
      list: (orgSlug: string, projectKey: string) =>
        request<ListResponse<TaskDto>>("GET", `${org(orgSlug)}/projects/${seg(projectKey)}/tasks`),
      get: (orgSlug: string, taskKey: string) => request<TaskDto>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}`),
      create: (orgSlug: string, projectKey: string, input: CreateTaskInput) =>
        request<TaskDto>("POST", `${org(orgSlug)}/projects/${seg(projectKey)}/tasks`, input),
      update: (orgSlug: string, taskKey: string, input: UpdateTaskInput) =>
        request<TaskDto>("PATCH", `${org(orgSlug)}/tasks/${seg(taskKey)}`, input),
      delete: (orgSlug: string, taskKey: string) =>
        request<void>("DELETE", `${org(orgSlug)}/tasks/${seg(taskKey)}`),
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
      /** Direct sub-tasks, oldest first. */
      subtasks: (orgSlug: string, taskKey: string) =>
        request<ListResponse<TaskDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/subtasks`),
      /** The task's history (created, updated fields, comments), oldest first. */
      activity: (orgSlug: string, taskKey: string) =>
        request<ListResponse<ActivityDto>>("GET", `${org(orgSlug)}/tasks/${seg(taskKey)}/activity`),
    },
  };
}
