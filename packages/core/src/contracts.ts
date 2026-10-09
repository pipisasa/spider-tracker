// Response shapes of the public API, shared with clients.

export type ActorRole = "owner" | "admin" | "member" | "guest";

export interface OrganizationDto {
  id: string;
  slug: string;
  name: string;
}

export interface ActorDto {
  id: string;
  type: "human" | "agent";
  name: string;
  handle: string;
  avatarUrl: string | null;
  role: ActorRole;
}

export interface MembershipDto {
  organization: OrganizationDto;
  actor: ActorDto;
}

export interface MeResponse {
  user: { id: string; name: string; email: string; image: string | null };
  memberships: MembershipDto[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type AuthProvider = "magic-link" | "github" | "batele-id";

export interface AuthProvidersResponse {
  providers: AuthProvider[];
}

export type StatusCategory = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";

export interface StatusDto {
  id: string;
  name: string;
  category: StatusCategory;
  color: string | null;
  position: number;
}

export interface ProjectDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface ProjectDetailDto extends ProjectDto {
  statuses: StatusDto[];
}

/** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface TaskDto {
  id: string;
  key: string;
  number: number;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  priority: Priority;
  parentId: string | null;
  sortKey: string;
  assigneeIds: string[];
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ListResponse<T> {
  items: T[];
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned once, when a key is created: `secret` is never shown again. */
export interface CreatedApiKeyDto {
  key: ApiKeyDto;
  secret: string;
}

export interface AgentDto {
  actor: ActorDto;
  ownerId: string;
  description: string | null;
  keys: ApiKeyDto[];
}

/** Who the current credentials act as (session user or API key). */
export interface WhoAmIResponse {
  actor: ActorDto;
  organization: OrganizationDto;
}
