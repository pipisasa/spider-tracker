import {
  acceptAgentInviteInput,
  bulkUpdateTasksInput,
  createAgentInviteInput,
  createAgentInput,
  createApiKeyInput,
  createCommentInput,
  createTagInput,
  createSavedViewInput,
  updateSavedViewInput,
  viewFiltersSchema,
  createOrganizationInput,
  deviceCodeInput,
  relationInput,
  relationKindSchema,
  createProjectInput,
  createTaskInput,
  createDocumentInput,
  createInvitationInput,
  invitationCodeInput,
  markInboxReadInput,
  updateAgentInput,
  updateDocumentInput,
  moveDocumentInput,
  updateProjectInput,
  updateTaskInput,
} from "@repo/core/schemas";
import { z } from "zod";

// OpenAPI 3.1 description of the public API, served at GET /openapi.json.
// Request bodies come from the same Zod schemas core validates with; response
// shapes mirror @repo/core/contracts.

type JsonSchema = Record<string, unknown>;

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: JsonSchema = {}): JsonSchema => ({ type: [type, "null"], ...extra });
const string = (extra: JsonSchema = {}): JsonSchema => ({ type: "string", ...extra });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
});
const listOf = (item: string): JsonSchema => object({ items: { type: "array", items: ref(item) } });

/** Request-side JSON Schema of a Zod schema, without the $schema header. */
function fromZod(schema: z.ZodType): JsonSchema {
  const jsonSchema: JsonSchema = z.toJSONSchema(schema, { io: "input" });
  delete jsonSchema.$schema;
  return jsonSchema;
}

const schemas: Record<string, JsonSchema> = {
  Error: object({ error: object({ code: string(), message: string() }) }),
  Organization: object({ id: string({ format: "uuid" }), slug: string(), name: string() }),
  Actor: object({
    id: string({ format: "uuid" }),
    type: string({ enum: ["human", "agent"] }),
    name: string(),
    handle: string(),
    avatarUrl: nullable("string"),
    role: string({ enum: ["owner", "admin", "member", "guest"] }),
    deactivated: { type: "boolean" },
    ownerId: nullable("string", { format: "uuid", description: "For agents, the owning person's actor id; null for people" }),
  }),
  Membership: object({ organization: ref("Organization"), actor: ref("Actor") }),
  Me: object({
    user: object({ id: string(), name: string(), email: string(), image: nullable("string") }),
    memberships: { type: "array", items: ref("Membership") },
  }),
  Status: object({
    id: string({ format: "uuid" }),
    name: string(),
    category: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
    color: nullable("string"),
    position: { type: "integer" },
  }),
  Project: object({
    id: string({ format: "uuid" }),
    key: string(),
    name: string(),
    description: nullable("string"),
    createdAt: string({ format: "date-time" }),
    archivedAt: nullable("string", {
      format: "date-time",
      description: "Archived projects are left out of lists and refuse new tasks",
    }),
  }),
  ProjectDetail: {
    allOf: [ref("Project"), object({ statuses: { type: "array", items: ref("Status") } })],
  },
  Task: object({
    id: string({ format: "uuid" }),
    key: string({ examples: ["SPI-12"] }),
    number: { type: "integer" },
    projectId: string({ format: "uuid" }),
    title: string(),
    description: nullable("string"),
    statusId: string({ format: "uuid" }),
    priority: { type: "integer", enum: [0, 1, 2, 3, 4], description: "0 none, 1 urgent, 2 high, 3 medium, 4 low" },
    parentId: nullable("string", { format: "uuid" }),
    parentKey: nullable("string", { examples: ["SPI-3"] }),
    sortKey: string(),
    assigneeIds: { type: "array", items: string({ format: "uuid" }) },
    tagIds: { type: "array", items: string({ format: "uuid" }) },
    creatorId: string({ format: "uuid" }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
    completedAt: nullable("string", { format: "date-time" }),
    subtasks: nullable("object", {
      description: "Direct sub-tasks the caller can see; closed = done or canceled. Null when there are none",
      properties: { done: { type: "integer" }, total: { type: "integer" } },
      required: ["done", "total"],
      additionalProperties: false,
    }),
  }),
  Presence: object({
    taskKey: string(),
    actorId: string({ format: "uuid" }),
    lastSeenAt: string({ format: "date-time", description: "Latest action or read by the agent on the task" }),
  }),
  Subtask: {
    allOf: [
      ref("Task"),
      object({
        status: object({
          id: string({ format: "uuid" }),
          name: string(),
          category: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
          color: nullable("string"),
        }),
      }),
    ],
  },
  Comment: object({
    id: string({ format: "uuid" }),
    taskKey: string(),
    parentId: nullable("string", { format: "uuid" }),
    authorId: string({ format: "uuid" }),
    body: string({ description: "Markdown; @handle mentions notify members" }),
    createdAt: string({ format: "date-time" }),
    editedAt: nullable("string", { format: "date-time" }),
  }),
  InboxItem: object({
    id: { type: "integer", description: "Increasing; use as the `after` cursor" },
    kind: string({ enum: ["mention", "assigned", "comment", "reply"] }),
    createdAt: string({ format: "date-time" }),
    readAt: nullable("string", { format: "date-time" }),
    task: object({ key: string(), title: string() }),
    comment: { oneOf: [object({ id: string({ format: "uuid" }), body: string() }), { type: "null" }] },
    from: object({ id: string({ format: "uuid" }), handle: string(), name: string(), type: string({ enum: ["human", "agent"] }) }),
  }),
  Tag: object({ id: string({ format: "uuid" }), name: string(), color: nullable("string") }),
  TagList: listOf("Tag"),
  CreateTagInput: fromZod(createTagInput),
  ViewFilters: fromZod(viewFiltersSchema),
  SavedView: object({
    id: string({ format: "uuid" }),
    projectKey: string(),
    ownerActorId: string({ format: "uuid" }),
    name: string(),
    filters: ref("ViewFilters"),
    shared: { type: "boolean" },
    view: string({ enum: ["board", "list"] }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
  }),
  SavedViewList: listOf("SavedView"),
  CreateSavedViewInput: fromZod(createSavedViewInput),
  UpdateSavedViewInput: fromZod(updateSavedViewInput),
  Relation: object({
    kind: string({ enum: ["blocks", "blocked_by", "relates", "duplicates", "duplicated_by"] }),
    task: object({ id: string({ format: "uuid" }), key: string(), title: string(), statusId: string({ format: "uuid" }) }),
  }),
  RelationList: listOf("Relation"),
  RelationInput: fromZod(relationInput),
  CommentList: listOf("Comment"),
  InboxList: listOf("InboxItem"),
  MarkedCount: object({ updated: { type: "integer" } }),
  CreateCommentInput: fromZod(createCommentInput),
  MarkInboxReadInput: fromZod(markInboxReadInput),
  DocumentSummary: object({
    id: string({ format: "uuid" }),
    title: string(),
    format: string({ enum: ["md", "html"] }),
    projectKey: nullable("string", { description: "Null for organization-wide documents" }),
    taskKey: nullable("string", { description: "Set for task documents" }),
    version: { type: "integer", description: "Increases with every save; send it back as baseVersion" },
    authorId: string({ format: "uuid", description: "Who saved the current version" }),
    createdBy: string({ format: "uuid" }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
  }),
  Document: { allOf: [ref("DocumentSummary"), object({ content: string() })] },
  DocumentList: listOf("DocumentSummary"),
  DocumentVersionSummary: object({
    version: { type: "integer" },
    title: string(),
    format: string({ enum: ["md", "html"] }),
    authorId: nullable("string", { format: "uuid" }),
    createdAt: string({ format: "date-time" }),
  }),
  DocumentVersion: {
    allOf: [ref("DocumentVersionSummary"), object({ documentId: string({ format: "uuid" }), content: string() })],
  },
  DocumentVersionList: listOf("DocumentVersionSummary"),
  DocumentLink: object({
    from: string({ format: "uuid", description: "The linking document" }),
    to: {
      oneOf: [
        object({ type: string({ const: "document" }), id: string({ format: "uuid" }) }),
        object({ type: string({ const: "task" }), key: string() }),
        object({ type: string({ const: "unresolved" }), title: string({ description: "As first written; titles match case-insensitively" }) }),
      ],
    },
  }),
  DocumentGraph: object({
    documents: { type: "array", items: ref("DocumentSummary") },
    tasks: {
      type: "array",
      items: object({
        key: string(),
        title: string(),
        projectKey: string(),
        statusCategory: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
      }),
    },
    projects: { type: "array", items: object({ key: string(), name: string() }) },
    links: { type: "array", items: ref("DocumentLink") },
  }),
  CreateDocumentInput: fromZod(createDocumentInput),
  UpdateDocumentInput: fromZod(updateDocumentInput),
  MoveDocumentInput: fromZod(moveDocumentInput),
  Invitation: object({
    id: string({ format: "uuid" }),
    code: string({ examples: ["ABCD-EFGH"], description: "Accepted with or without the dash, in any case" }),
    role: string({ enum: ["admin", "member", "guest"] }),
    status: string({ enum: ["active", "expired", "revoked", "used_up"] }),
    useCount: { type: "integer" },
    maxUses: nullable("integer"),
    expiresAt: string({ format: "date-time" }),
    revokedAt: nullable("string", { format: "date-time" }),
    createdBy: nullable("string", { format: "uuid" }),
    createdAt: string({ format: "date-time" }),
  }),
  InvitationList: listOf("Invitation"),
  InvitationPreview: object({
    organization: ref("Organization"),
    role: string({ enum: ["admin", "member", "guest"] }),
    alreadyMember: { type: "boolean" },
  }),
  CreateInvitationInput: fromZod(createInvitationInput),
  InvitationCodeInput: fromZod(invitationCodeInput),
  ApiKey: object({
    id: string({ format: "uuid" }),
    name: string(),
    prefix: string({ examples: ["spt_a1b2c3"], description: "First characters of the key, to recognise it" }),
    createdAt: string({ format: "date-time" }),
    lastUsedAt: nullable("string", { format: "date-time" }),
    revokedAt: nullable("string", { format: "date-time" }),
  }),
  CreatedApiKey: object({ key: ref("ApiKey"), secret: string({ description: "Shown only once" }) }),
  Agent: object({
    actor: ref("Actor"),
    ownerId: string({ format: "uuid" }),
    owner: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
    description: nullable("string"),
    canManage: { type: "boolean", description: "The caller owns the agent or is an organization owner/admin" },
    keys: { type: "array", items: ref("ApiKey"), description: "Empty unless canManage" },
    projects: {
      type: ["array", "null"],
      items: ref("ProjectRef"),
      description: "Projects the agent is limited to (empty once they are all deleted); null when it sees every project",
    },
  }),
  AgentList: listOf("Agent"),
  ProjectRef: object({ key: string(), name: string() }),
  AgentInvite: object({
    id: string({ format: "uuid" }),
    code: string({ examples: ["ABCD-EFGH"] }),
    status: string({ enum: ["pending", "expired"] }),
    expiresAt: string({ format: "date-time" }),
    createdAt: string({ format: "date-time" }),
    createdBy: nullable("string", { format: "uuid" }),
    agent: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
    projects: { type: "array", items: ref("ProjectRef") },
  }),
  AgentInviteList: listOf("AgentInvite"),
  CreatedAgentInvite: object({
    invite: ref("AgentInvite"),
    agent: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
  }),
  AcceptedAgentInvite: object({
    token: string({ description: "The agent's API key (spt_…); shown only once" }),
    actor: ref("Actor"),
    organization: ref("Organization"),
    projects: { type: "array", items: ref("ProjectRef") },
    owner: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
  }),
  CreateAgentInviteInput: fromZod(createAgentInviteInput),
  AcceptAgentInviteInput: fromZod(acceptAgentInviteInput),
  CreateAgentInput: fromZod(createAgentInput),
  UpdateAgentInput: fromZod(updateAgentInput),
  CreateApiKeyInput: fromZod(createApiKeyInput),
  ActorList: listOf("Actor"),
  ProjectList: listOf("Project"),
  TaskList: listOf("Task"),
  SubtaskList: listOf("Subtask"),
  PresenceList: listOf("Presence"),
  CreateProjectInput: fromZod(createProjectInput),
  UpdateProjectInput: fromZod(updateProjectInput),
  CreateTaskInput: fromZod(createTaskInput),
  UpdateTaskInput: fromZod(updateTaskInput),
  BulkUpdateTasksInput: fromZod(bulkUpdateTasksInput),
  BulkTaskResult: object({
    key: string({ description: "The task's key; for an error, the key as given" }),
    outcome: string({ enum: ["changed", "unchanged", "error"], description: 'In a dry run, "changed" means it would change' }),
    task: { oneOf: [ref("Task"), { type: "null" }], description: "The task after the change (as it would be, in a dry run); null on error" },
    error: nullable("object", {
      description: 'Why this task wasn\'t changed, e.g. { code: "not_found" } for a missing or out-of-scope task',
      properties: { code: string(), message: string() },
      required: ["code", "message"],
    }),
  }),
  BulkUpdateTasksResult: object({
    dryRun: { type: "boolean" },
    summary: object({ changed: { type: "integer" }, unchanged: { type: "integer" }, failed: { type: "integer" } }),
    results: { type: "array", items: ref("BulkTaskResult"), description: "In the order of the keys given, or board order for a filter" },
  }),
  CreateOrganizationInput: fromZod(createOrganizationInput),
  AuthProviders: object({ providers: { type: "array", items: string({ enum: ["magic-link", "github", "batele-id"] }) } }),
  Activity: object({
    id: { type: "integer", description: "Increasing; entries come oldest first" },
    action: string({ examples: ["task.created", "task.updated", "comment.created"] }),
    changes: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "For task.updated: field → [before, after] (statusId, assigneeIds, tagIds, parentId, title, priority, …)",
    },
    source: string({ enum: ["ui", "api", "mcp", "cli", "git", "agent_run"] }),
    actorId: string({ format: "uuid" }),
    createdAt: string({ format: "date-time" }),
  }),
  ActivityList: listOf("Activity"),
  DeviceCodeInput: fromZod(deviceCodeInput),
  DeviceTokenInput: {
    type: "object",
    properties: { grant_type: string({ const: "urn:ietf:params:oauth:grant-type:device_code" }), device_code: string() },
    required: ["device_code"],
  },
  DeviceCode: object({
    device_code: string(),
    user_code: string({ examples: ["WDJB-MJHT"] }),
    verification_uri: string({ format: "uri" }),
    verification_uri_complete: string({ format: "uri" }),
    expires_in: { type: "integer" },
    interval: { type: "integer" },
  }),
  DeviceToken: object({
    access_token: string({ description: "The device agent's API key (spt_…), returned once" }),
    token_type: string({ enum: ["Bearer"] }),
    actor: ref("Actor"),
    organization: ref("Organization"),
  }),
  DeviceTokenError: object({
    error: string({
      enum: ["invalid_request", "authorization_pending", "slow_down", "expired_token", "access_denied", "invalid_grant"],
    }),
  }),
  DeviceRequest: object({
    userCode: string(),
    clientName: string(),
    status: string({ enum: ["pending", "approved", "denied", "consumed"] }),
    expiresAt: string({ format: "date-time" }),
  }),
  DeviceApproveInput: object({ orgSlug: string() }),
};

const json = (schema: string) => ({ content: { "application/json": { schema: ref(schema) } } });
const ok = (description: string, schema: string) => ({ description, ...json(schema) });
const errors = {
  "400": { description: "Invalid input", ...json("Error") },
  "401": { description: "Missing or invalid credentials", ...json("Error") },
  "403": { description: "Not allowed", ...json("Error") },
  "404": { description: "Not found (also for organizations you are not a member of)", ...json("Error") },
  "409": { description: "Conflict: already exists, or a document saved since your baseVersion", ...json("Error") },
  "429": { description: "Rate-limited (agent comment loop guards, per-IP limits on public endpoints)", ...json("Error") },
};
const rateLimited = (description: string) => ({ "429": { description, ...json("Error") } });
const invitationLimits = rateLimited(
  "Rate-limited: more than 20 invitation requests a minute from this client IP, or 10 from this user",
);
const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const orgSlug = pathParam("orgSlug", "Organization slug");
const projectKey = pathParam("projectKey", 'Project key, e.g. "SPI"');
const taskKey = pathParam("taskKey", 'Task key, e.g. "SPI-12"');
const userCode = pathParam("userCode", 'Code shown by spider login, e.g. "WDJB-MJHT"');
const body = (schema: string) => ({ required: true, ...json(schema) });
/** RFC 8628 endpoints accept JSON or form-encoded bodies. */
const jsonOrForm = (schema: string) => ({
  "application/json": { schema: ref(schema) },
  "application/x-www-form-urlencoded": { schema: ref(schema) },
});

const paths = {
  "/health": {
    get: { operationId: "health", summary: "Liveness, with the oldest supported CLI version", security: [], responses: { "200": { description: "OK" } } },
  },
  "/health/ready": {
    get: { operationId: "ready", summary: "Readiness: the database answers", security: [], responses: { "200": { description: "OK" } } },
  },
  "/auth/providers": {
    get: {
      operationId: "authProviders",
      summary: "Sign-in methods enabled on this server",
      security: [],
      responses: { "200": ok("Enabled providers", "AuthProviders") },
    },
  },
  "/device/code": {
    post: {
      operationId: "startDeviceAuthorization",
      summary: "Start a spider login (RFC 8628 device authorization). Rate limited per client IP",
      security: [],
      requestBody: { required: false, content: jsonOrForm("DeviceCodeInput") },
      responses: { "200": ok("Device and user codes", "DeviceCode"), "429": errors["429"] },
    },
  },
  "/device/token": {
    post: {
      operationId: "pollDeviceToken",
      summary: "Poll until the login is approved; then returns the device agent's API key",
      security: [],
      requestBody: { required: true, content: jsonOrForm("DeviceTokenInput") },
      responses: {
        "200": ok("The device agent's key", "DeviceToken"),
        "400": { description: "Pending, slowed down, denied, expired or invalid (RFC 8628 error)", ...json("DeviceTokenError") },
      },
    },
  },
  "/v1/device/{userCode}": {
    parameters: [userCode],
    get: {
      operationId: "getDeviceRequest",
      summary: "A pending device login, for the approval page (browser sessions only)",
      responses: { "200": ok("Device request", "DeviceRequest"), ...errors },
    },
  },
  "/v1/device/{userCode}/approve": {
    parameters: [userCode],
    post: {
      operationId: "approveDevice",
      summary: "Approve a device login for one of your organizations (owners, admins and members; browser sessions only)",
      requestBody: body("DeviceApproveInput"),
      responses: { "204": { description: "Approved" }, ...errors },
    },
  },
  "/v1/device/{userCode}/deny": {
    parameters: [userCode],
    post: {
      operationId: "denyDevice",
      summary: "Deny a device login (browser sessions only)",
      responses: { "204": { description: "Denied" }, ...errors },
    },
  },
  "/v1/organizations": {
    post: {
      operationId: "createOrganization",
      summary: "Create an organization; you become its owner (browser sessions only)",
      requestBody: body("CreateOrganizationInput"),
      responses: { "201": ok("New membership", "Membership"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/events": {
    parameters: [orgSlug],
    get: {
      operationId: "streamEvents",
      summary: "Server-sent change events (ids and keys only; refetch through the normal routes)",
      responses: {
        "200": { description: "SSE stream of ready, ping and change events", content: { "text/event-stream": { schema: string() } } },
        ...errors,
      },
    },
  },
  "/v1/whoami": {
    get: {
      operationId: "whoami",
      summary: "The agent an API key acts as, and its organization",
      responses: { "200": ok("Current agent", "Membership"), ...errors },
    },
  },
  "/v1/me": {
    get: {
      operationId: "me",
      summary: "The signed-in person and their organizations (browser sessions only)",
      responses: { "200": ok("Current user", "Me"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/members": {
    parameters: [orgSlug],
    get: {
      operationId: "listMembers",
      summary: "List people and agents in the organization",
      parameters: [
        {
          name: "all",
          in: "query",
          schema: { type: "boolean" },
          description: "Include deactivated people and deleted agents (e.g. to name tasks' former assignees)",
        },
      ],
      responses: { "200": ok("Members", "ActorList"), ...errors },
    },
  },
  "/v1/invitations/preview": {
    post: {
      operationId: "previewInvitation",
      summary: "The organization and role an invitation code joins (browser sessions only)",
      requestBody: body("InvitationCodeInput"),
      responses: { "200": ok("Invitation preview", "InvitationPreview"), ...errors, ...invitationLimits },
    },
  },
  "/v1/invitations/accept": {
    post: {
      operationId: "acceptInvitation",
      summary: "Join an organization with an invitation code (browser sessions only)",
      requestBody: body("InvitationCodeInput"),
      responses: { "201": ok("New membership", "Membership"), ...errors, ...invitationLimits },
    },
  },
  "/v1/orgs/{orgSlug}/invitations": {
    parameters: [orgSlug],
    get: {
      operationId: "listInvitations",
      summary: "Active invitation codes and recently expired or revoked ones (owners and admins)",
      responses: { "200": ok("Invitations", "InvitationList"), ...errors },
    },
    post: {
      operationId: "createInvitation",
      summary: "Create an invitation code (owners and admins; only owners can invite admins)",
      requestBody: body("CreateInvitationInput"),
      responses: { "201": ok("Created invitation", "Invitation"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/invitations/{invitationId}": {
    parameters: [orgSlug, pathParam("invitationId", "Invitation id")],
    delete: {
      operationId: "revokeInvitation",
      summary: "Revoke an invitation code",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agents": {
    parameters: [orgSlug],
    get: {
      operationId: "listAgents",
      summary: "Active agents with their owners; keys only for agents you can manage",
      responses: { "200": ok("Agents", "AgentList"), ...errors },
    },
    post: {
      operationId: "createAgent",
      summary: "Create an agent owned by you (people with owner, admin or member role; not guests or agent keys)",
      requestBody: body("CreateAgentInput"),
      responses: { "201": ok("Created agent", "Agent"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agents/me": {
    parameters: [orgSlug],
    patch: {
      operationId: "updateAgentMe",
      summary: "An agent changes its own name, handle or description (agent API keys)",
      requestBody: body("UpdateAgentInput"),
      responses: { "200": ok("Updated agent", "Agent"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agent-invites": {
    parameters: [orgSlug],
    get: {
      operationId: "listAgentInvites",
      summary: "Unused agent invites for agents you can manage (recently expired ones included)",
      responses: { "200": ok("Agent invites", "AgentInviteList"), ...errors },
    },
    post: {
      operationId: "createAgentInvite",
      summary: "Create a pending agent limited to some projects, with a one-time setup code (people who can create agents)",
      requestBody: body("CreateAgentInviteInput"),
      responses: { "201": ok("Created invite", "CreatedAgentInvite"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agent-invites/{inviteId}": {
    parameters: [orgSlug, pathParam("inviteId", "Agent invite id")],
    delete: {
      operationId: "revokeAgentInvite",
      summary: "Revoke an unused agent invite and remove its pending agent",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
  "/v1/agent-invites/accept": {
    post: {
      operationId: "acceptAgentInvite",
      summary:
        "Accept an agent invite without signing in (the code is the credential): activates the agent and returns its first API key. `code` may be the invite link. Rate limited per client IP",
      security: [],
      requestBody: body("AcceptAgentInviteInput"),
      responses: {
        "201": ok("The agent's key and scope", "AcceptedAgentInvite"),
        ...errors,
        ...rateLimited(
          "Rate-limited: more than 10 attempts a minute from this client IP, or more than 100 invalid codes an hour across all clients",
        ),
      },
    },
  },
  "/v1/orgs/{orgSlug}/agents/{agentId}": {
    parameters: [orgSlug, pathParam("agentId", "Agent actor id")],
    patch: {
      operationId: "updateAgent",
      summary: "Change an agent's name, handle or description (its owner, or owners and admins)",
      requestBody: body("UpdateAgentInput"),
      responses: { "200": ok("Updated agent", "Agent"), ...errors },
    },
    delete: {
      operationId: "deleteAgent",
      summary: "Deactivate an agent and revoke its keys; its history and assignments stay",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agents/{agentId}/keys": {
    parameters: [orgSlug, pathParam("agentId", "Agent actor id")],
    post: {
      operationId: "createApiKey",
      summary: "Issue an API key for an agent you can manage; the secret is returned only once",
      requestBody: body("CreateApiKeyInput"),
      responses: { "201": ok("Created key", "CreatedApiKey"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/api-keys/{keyId}": {
    parameters: [orgSlug, pathParam("keyId", "API key id")],
    delete: {
      operationId: "revokeApiKey",
      summary: "Revoke a key of an agent you can manage",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects": {
    parameters: [orgSlug],
    get: {
      operationId: "listProjects",
      summary: "List projects",
      parameters: [
        { name: "archived", in: "query", schema: { type: "boolean" }, description: "Include archived projects" },
      ],
      responses: { "200": ok("Projects", "ProjectList"), ...errors },
    },
    post: {
      operationId: "createProject",
      summary: "Create a project with the default statuses (owners, admins and their agents)",
      requestBody: body("CreateProjectInput"),
      responses: { "201": ok("Created project", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "getProject",
      summary: "Get a project with its statuses (archived ones too)",
      responses: { "200": ok("Project", "ProjectDetail"), ...errors },
    },
    patch: {
      operationId: "updateProject",
      summary: "Change a project's name or description (owners, admins and their agents); the key can't change",
      requestBody: body("UpdateProjectInput"),
      responses: { "200": ok("Updated project", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/archive": {
    parameters: [orgSlug, projectKey],
    post: {
      operationId: "archiveProject",
      summary: "Archive a project: hidden from lists, no new tasks (owners, admins and their agents)",
      responses: { "200": ok("Archived project", "ProjectDetail"), ...errors },
    },
    delete: {
      operationId: "unarchiveProject",
      summary: "Restore an archived project (owners, admins and their agents)",
      responses: { "200": ok("Restored project", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/tasks": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listTasks",
      summary: "List a project's tasks in board order, optionally filtered",
      description:
        "Repeat a parameter for several values. Statuses, assignees and priorities match any of their values; " +
        "a task must carry every `tag` (or any of them with `tagMatch=any`); parameters combine with AND. " +
        "Missing or out-of-scope projects are 404s; unknown statuses, members and tags are 400s.",
      parameters: [
        {
          name: "status",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          description: 'Status id, name or category ("In Progress", "in_progress"), case-insensitive',
        },
        {
          name: "assignee",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          description:
            'Actor id or handle (deactivated ones too), "me", "mine" (you and your agents; for an agent key, ' +
            "its owner and the owner's agents, deleted ones too), or \"none\" for unassigned tasks",
        },
        {
          name: "tag",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          description: "Tag name, case-insensitive; the task must have all of them (see tagMatch)",
        },
        {
          name: "tagMatch",
          in: "query",
          schema: { type: "string", enum: ["all", "any"], default: "all" },
          description: "all: the task has every `tag`; any: at least one",
        },
        {
          name: "priority",
          in: "query",
          schema: { type: "array", items: { type: "integer", minimum: 0, maximum: 4 } },
          description: "0 none, 1 urgent, 2 high, 3 medium, 4 low",
        },
        { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive text in the title" },
        { name: "parent", in: "query", schema: { type: "string" }, description: 'Direct sub-tasks of this task key, e.g. "SPI-3"' },
      ],
      responses: { "200": ok("Tasks", "TaskList"), ...errors },
    },
    post: {
      operationId: "createTask",
      summary: "Create a task",
      requestBody: body("CreateTaskInput"),
      responses: { "201": ok("Created task", "Task"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/presence": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listPresence",
      summary:
        "Agents working on the project's tasks right now: they acted on a task (activity log) or read it through the API, CLI or MCP within the last 10 minutes",
      responses: { "200": ok("Active agents per task", "PresenceList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/views": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listSavedViews",
      summary: "The project's shared saved views plus your own",
      responses: { "200": ok("Saved views", "SavedViewList"), ...errors },
    },
    post: {
      operationId: "createSavedView",
      summary: "Save a filter set (personal unless shared); not for guests",
      requestBody: body("CreateSavedViewInput"),
      responses: { "201": ok("Created view", "SavedView"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/views/{viewId}": {
    parameters: [orgSlug, projectKey, pathParam("viewId", "Saved view id")],
    patch: {
      operationId: "updateSavedView",
      summary: "Rename or change a view (its owner, or organization owners and admins)",
      requestBody: body("UpdateSavedViewInput"),
      responses: { "200": ok("Updated view", "SavedView"), ...errors },
    },
    delete: {
      operationId: "deleteSavedView",
      summary: "Delete a view (its owner, or organization owners and admins)",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/bulk-update": {
    parameters: [orgSlug],
    post: {
      operationId: "bulkUpdateTasks",
      summary: "Update several tasks at once, by keys or a filter (at most 100)",
      description:
        "Pass `keys` (any projects) or `filter` (one project; the same filters as listing tasks, plus `parent`), and `set`: " +
        "`status` (id, name or category, matched in each task's own project), `priority`, `assigneeIds`, `tagIds` (both replace the lists), `parentId`. " +
        "Each task is updated on its own with the same permission and agent-scope checks as PATCH /tasks/{taskKey}; " +
        "a task that fails (missing, out of scope, unknown status, …) is reported in `results` without stopping the others, so the response is 200. " +
        "`dryRun: true` reports the outcomes without changing anything. More than 100 keys, or a filter matching more than 100 tasks, is a 400 and changes nothing.",
      requestBody: body("BulkUpdateTasksInput"),
      responses: { "200": ok("One result per task", "BulkUpdateTasksResult"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "getTask",
      summary: "Get a task",
      responses: { "200": ok("Task", "Task"), ...errors },
    },
    patch: {
      operationId: "updateTask",
      summary: "Update a task; send only the fields to change",
      requestBody: body("UpdateTaskInput"),
      responses: { "200": ok("Updated task", "Task"), ...errors },
    },
    delete: {
      operationId: "deleteTask",
      summary: "Delete a task",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/subtasks": {
    parameters: [orgSlug, taskKey],
    get: { operationId: "listSubtasks", summary: "Direct sub-tasks of a task", responses: { "200": ok("Sub-tasks, each with its own status", "SubtaskList"), ...errors } },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/relations": {
    parameters: [orgSlug, taskKey],
    get: { operationId: "listRelations", summary: "Links to other tasks, from this task's point of view", responses: { "200": ok("Relations", "RelationList"), ...errors } },
    post: {
      operationId: "addRelation",
      summary: "Link this task to another (blocks, blocked_by, relates, duplicates, duplicated_by)",
      requestBody: body("RelationInput"),
      responses: { "201": ok("Created link", "Relation"), ...errors },
    },
    delete: {
      operationId: "removeRelation",
      summary: "Remove a link",
      parameters: [
        { name: "kind", in: "query", required: true, schema: { type: "string", enum: relationKindSchema.options } },
        { name: "task", in: "query", required: true, schema: { type: "string" }, description: "The other task's key" },
      ],
      responses: { "204": { description: "Removed" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/activity": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "listTaskActivity",
      summary: "A task's history from the activity log, oldest first",
      responses: { "200": ok("Activity", "ActivityList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/comments": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "listComments",
      summary: "Comments on a task, oldest first",
      responses: { "200": ok("Comments", "CommentList"), ...errors },
    },
    post: {
      operationId: "addComment",
      summary: "Comment on a task; @mentions, replies and assignees are notified",
      requestBody: body("CreateCommentInput"),
      responses: { "201": ok("Created comment", "Comment"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tags": {
    parameters: [orgSlug],
    get: { operationId: "listTags", summary: "The organization's tags", responses: { "200": ok("Tags", "TagList"), ...errors } },
    post: {
      operationId: "createTag",
      summary: "Create a tag",
      requestBody: body("CreateTagInput"),
      responses: { "201": ok("Created tag", "Tag"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tags/{tagId}": {
    parameters: [orgSlug, pathParam("tagId", "Tag id")],
    delete: {
      operationId: "deleteTag",
      summary: "Delete a tag (owners and admins); it is removed from every task",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents": {
    parameters: [orgSlug],
    get: {
      operationId: "listDocuments",
      summary: "Documents without content, most recently updated first",
      parameters: [
        { name: "project", in: "query", schema: { type: "string" }, description: "A project's documents, including its tasks'" },
        { name: "task", in: "query", schema: { type: "string" }, description: "A task's documents" },
      ],
      responses: { "200": ok("Documents", "DocumentList"), ...errors },
    },
    post: {
      operationId: "createDocument",
      summary: "Create a document: organization-wide, or in a project or task (by key)",
      requestBody: body("CreateDocumentInput"),
      responses: { "201": ok("Created document", "Document"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/graph": {
    parameters: [orgSlug],
    get: {
      operationId: "getDocumentGraph",
      summary:
        "Documents as a graph: visible documents, the tasks and projects they sit in or link to, and their links ([[Title]], [[KEY-1]] and plain task keys)",
      responses: { "200": ok("Graph", "DocumentGraph"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: { operationId: "getDocument", summary: "A document with its content", responses: { "200": ok("Document", "Document"), ...errors } },
    patch: {
      operationId: "updateDocument",
      summary: "Save a new version; 409 if the document was saved since baseVersion",
      requestBody: body("UpdateDocumentInput"),
      responses: { "200": ok("Updated document", "Document"), ...errors },
    },
    delete: { operationId: "deleteDocument", summary: "Delete a document", responses: { "204": { description: "Deleted" }, ...errors } },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/move": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    post: {
      operationId: "moveDocument",
      summary: "Move a document to a project (key), or make it organization-wide (null); keeps id and versions, detaches it from a task",
      requestBody: body("MoveDocumentInput"),
      responses: { "200": ok("Moved document", "Document"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/backlinks": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: {
      operationId: "listDocumentBacklinks",
      summary: "Documents linking here with [[its title]], most recently updated first",
      responses: { "200": ok("Linking documents", "DocumentList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/versions": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: {
      operationId: "listDocumentVersions",
      summary: "Saved versions, newest first, without content",
      responses: { "200": ok("Versions", "DocumentVersionList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/versions/{version}": {
    parameters: [orgSlug, pathParam("documentId", "Document id"), pathParam("version", "Version number")],
    get: { operationId: "getDocumentVersion", summary: "One saved version with its content", responses: { "200": ok("Version", "DocumentVersion"), ...errors } },
  },
  "/v1/orgs/{orgSlug}/inbox": {
    parameters: [orgSlug],
    get: {
      operationId: "listInbox",
      summary: "The caller's notifications, oldest first; can wait for new items",
      parameters: [
        { name: "after", in: "query", schema: { type: "integer" }, description: "Only items with a larger id" },
        { name: "unread", in: "query", schema: { type: "boolean" }, description: "Only unread items" },
        { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
        { name: "wait", in: "query", schema: { type: "integer", maximum: 25 }, description: "Seconds to wait for a new item" },
      ],
      responses: { "200": ok("Inbox items", "InboxList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/inbox/read": {
    parameters: [orgSlug],
    post: {
      operationId: "markInboxRead",
      summary: "Mark items read, by ids or up to an id",
      requestBody: body("MarkInboxReadInput"),
      responses: { "200": ok("Number of items marked", "MarkedCount"), ...errors },
    },
  },
  "/v1/api-keys/current": {
    delete: {
      operationId: "revokeCurrentApiKey",
      summary: "Revoke the API key this request is made with (spider logout)",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
};

export function openApiDocument(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Spider Tracker API",
      version: "1",
      description:
        'Agents authenticate with an API key ("Authorization: Bearer spt_…"); the web app uses its session cookie. ' +
        'API-key clients may send "X-Spider-Source: cli | mcp | api" to label their activity. ' +
        '/v1 and /mcp responses carry "X-Spider-Min-Cli: <version>", the oldest spider CLI this server supports.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "spt_…" },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description: "Browser session (prefixed with __Secure- over HTTPS)",
        },
      },
      schemas,
    },
  };
}
