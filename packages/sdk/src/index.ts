import type {
  ActorDto,
  ApiErrorBody,
  ListResponse,
  MeResponse,
  ProjectDetailDto,
  ProjectDto,
  TaskDto,
  WhoAmIResponse,
} from "@repo/core/contracts";
import type { CreateTaskInput, UpdateTaskInput } from "@repo/core/schemas";

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

  const org = (slug: string) => `/v1/orgs/${encodeURIComponent(slug)}`;
  const seg = encodeURIComponent;

  return {
    /** The agent an API key acts as, and its organization. */
    whoami: () => request<WhoAmIResponse>("GET", "/v1/whoami"),
    /** The signed-in person and their organizations (browser sessions only). */
    me: () => request<MeResponse>("GET", "/v1/me"),

    members: {
      list: (orgSlug: string) => request<ListResponse<ActorDto>>("GET", `${org(orgSlug)}/members`),
    },

    projects: {
      list: (orgSlug: string) => request<ListResponse<ProjectDto>>("GET", `${org(orgSlug)}/projects`),
      get: (orgSlug: string, projectKey: string) =>
        request<ProjectDetailDto>("GET", `${org(orgSlug)}/projects/${seg(projectKey)}`),
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
    },
  };
}
