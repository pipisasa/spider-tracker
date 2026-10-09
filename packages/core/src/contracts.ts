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
  /** The parent's key, e.g. "ST-3", when parentId is set. */
  parentKey: string | null;
  sortKey: string;
  assigneeIds: string[];
  tagIds: string[];
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
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

/** POST /device/code (RFC 8628 §3.2). */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** A pending `spider login`, as shown on the approval page. */
export interface DeviceRequestDto {
  userCode: string;
  clientName: string;
  status: "pending" | "approved" | "denied" | "consumed";
  expiresAt: string;
}

/** POST /device/token once approved: an agent API key for the device. */
export interface DeviceTokenResponse {
  access_token: string;
  token_type: "Bearer";
  actor: ActorDto;
  organization: OrganizationDto;
}

export interface CommentDto {
  id: string;
  taskKey: string;
  parentId: string | null;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export type InboxKind = "mention" | "assigned" | "comment" | "reply";

export interface InboxItemDto {
  /** Increasing; pass the last one seen as `after` to get only newer items. */
  id: number;
  kind: InboxKind;
  createdAt: string;
  readAt: string | null;
  task: { key: string; title: string };
  comment: { id: string; body: string } | null;
  from: { id: string; handle: string; name: string; type: "human" | "agent" };
}

/** One entry of a task's history, from the activity log. */
export interface ActivityDto {
  id: number;
  /** e.g. "task.created", "task.updated", "comment.created" */
  action: string;
  /** For task.updated: field → [before, after] (statusId, assigneeIds, title, priority, …). */
  changes: Record<string, unknown> | null;
  /** ui | api | mcp | cli | git | agent_run */
  source: string;
  actorId: string;
  createdAt: string;
}

/** How a related task relates to this one, from this task's point of view. */
export type RelationKind = "blocks" | "blocked_by" | "relates" | "duplicates" | "duplicated_by";

export interface RelationDto {
  kind: RelationKind;
  task: { id: string; key: string; title: string; statusId: string };
}
