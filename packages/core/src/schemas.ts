import { z } from "zod";

// Shared between backend validation and web forms.

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "At least 2 characters")
  .max(40, "At most 40 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single dashes");

export const createOrganizationInput = z.object({
  name: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
  slug: slugSchema,
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationInput>;

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "2–10 letters or digits, starting with a letter");

const projectName = z.string().trim().min(1, "Required").max(80, "At most 80 characters");

export const createProjectInput = z.object({
  name: projectName,
  key: projectKeySchema,
  description: z.string().trim().max(2000).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectInput>;

/** The key can't change: it is part of every task key. */
export const updateProjectInput = z
  .object({
    name: projectName.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const taskTitle = z.string().trim().min(1, "Required").max(255, "At most 255 characters");
const taskDescription = z.string().max(50_000).nullable();

export const createTaskInput = z.object({
  title: taskTitle,
  description: taskDescription.optional(),
  statusId: z.uuid().optional(),
  priority: prioritySchema.optional(),
  assigneeIds: z.array(z.uuid()).max(20).optional(),
  tagIds: z.array(z.uuid()).max(20).optional(),
  parentId: z.uuid().nullable().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskInput>;

/** Place a task between two neighbours in a status column; omit both to append. */
export const taskPositionInput = z.object({
  statusId: z.uuid(),
  afterId: z.uuid().nullable().optional(),
  beforeId: z.uuid().nullable().optional(),
});

export const updateTaskInput = z
  .object({
    title: taskTitle,
    description: taskDescription,
    statusId: z.uuid(),
    priority: prioritySchema,
    assigneeIds: z.array(z.uuid()).max(20),
    tagIds: z.array(z.uuid()).max(20),
    parentId: z.uuid().nullable(),
    position: taskPositionInput,
  })
  .partial();

export type UpdateTaskInput = z.infer<typeof updateTaskInput>;

const filterValue = z.string().trim().min(1).max(100);

/**
 * Server-side filters of a project's task list (API query, MCP, CLI). Values within `status`,
 * `assignee` and `priority` are OR-ed; a task must carry every one of `tags`; keys are AND-ed.
 */
export const taskListFilters = z.object({
  /** Status ids, names or categories ("In Progress", "in_progress"), case-insensitive. */
  status: z.array(filterValue).max(50).optional(),
  /** Actor ids, handles (with or without "@", deactivated ones too), "me" or "none". */
  assignee: z.array(filterValue).max(50).optional(),
  /** Tag names, case-insensitive (with or without "#"). */
  tags: z.array(filterValue).max(20).optional(),
  /** 0–4; numeric strings too, as they arrive in a query string. */
  priority: z
    .array(z.union([prioritySchema, z.enum(["0", "1", "2", "3", "4"]).transform(Number).pipe(prioritySchema)]))
    .max(5)
    .optional(),
  /** Case-insensitive text in the title. */
  q: z.string().trim().max(200).optional(),
});

export type TaskListFilters = z.input<typeof taskListFilters>;

/** Parses "SPI-12" into its project key and number. */
export function parseTaskKey(value: string): { projectKey: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { projectKey: match[1].toUpperCase(), number: Number(match[2]) };
}

const agentName = z.string().trim().min(1, "Required").max(80, "At most 80 characters");
const agentHandle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single dashes")
  .max(32);

export const createAgentInput = z.object({
  name: agentName,
  handle: agentHandle.optional(),
  description: z.string().trim().max(500).optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentInput>;

export const updateAgentInput = z
  .object({
    name: agentName.optional(),
    handle: agentHandle.optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateAgentInput = z.infer<typeof updateAgentInput>;

export const createAgentInviteInput = z.object({
  projectKeys: z
    .array(z.string().trim().min(1).max(10))
    .min(1, "Pick at least one project")
    .max(100),
  expiresInDays: z.number().int().min(1, "At least 1 day").max(30, "At most 30 days").default(7),
});

export type CreateAgentInviteInput = z.input<typeof createAgentInviteInput>;

/** The code may also be the invite link (…/agent-invite/ABCD-EFGH or …?code=ABCD-EFGH). */
export const acceptAgentInviteInput = z.object({
  code: z.string().trim().min(1, "Enter an invitation code").max(500),
  name: agentName.optional(),
  handle: agentHandle.optional(),
  description: z.string().trim().max(500).optional(),
});

export type AcceptAgentInviteInput = z.infer<typeof acceptAgentInviteInput>;

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
});

export const deviceCodeInput = z.object({
  client_name: z.string().trim().min(1).max(60).default("CLI"),
});

export const createCommentInput = z.object({
  body: z.string().trim().min(1, "Required").max(20_000, "At most 20,000 characters"),
  parentId: z.uuid().nullable().optional(),
});

export type CreateCommentInput = z.infer<typeof createCommentInput>;

export const inboxQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  // Query strings: "true"/"1" mean yes (z.coerce.boolean would read "false" as true).
  unread: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const markInboxReadInput = z
  .object({
    ids: z.array(z.number().int().positive()).max(500).optional(),
    upTo: z.number().int().positive().optional(),
  })
  .refine((v) => v.ids !== undefined || v.upTo !== undefined, "Pass ids or upTo");

export const createTagInput = z.object({
  name: z.string().trim().min(1, "Required").max(40, "At most 40 characters"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "A hex colour like #22c55e")
    .optional(),
});

export type CreateTagInput = z.infer<typeof createTagInput>;

export const relationKindSchema = z.enum(["blocks", "blocked_by", "relates", "duplicates", "duplicated_by"]);

export const relationInput = z.object({
  kind: relationKindSchema,
  /** The other task's key, e.g. "ST-12". */
  task: z.string().trim().min(1),
});

export type RelationInput = z.infer<typeof relationInput>;

export const documentFormatSchema = z.enum(["md", "html"]);

/** Documents are capped at 1 MB of UTF-8. */
export const MAX_DOCUMENT_BYTES = 1_000_000;

const documentTitle = z.string().trim().min(1, "Required").max(255, "At most 255 characters");
const documentContent = z
  .string()
  .refine((v) => new TextEncoder().encode(v).length <= MAX_DOCUMENT_BYTES, "At most 1 MB");

/** Scope: `task` (which implies its project), `project`, or neither for an organization-wide document. */
export const createDocumentInput = z.object({
  title: documentTitle,
  format: documentFormatSchema.default("md"),
  content: documentContent.default(""),
  project: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
});

export type CreateDocumentInput = z.input<typeof createDocumentInput>;

/** `baseVersion` is the version the edit started from; a newer saved version means a conflict. */
export const updateDocumentInput = z.object({
  baseVersion: z.number().int().positive(),
  title: documentTitle.optional(),
  format: documentFormatSchema.optional(),
  content: documentContent.optional(),
});

export type UpdateDocumentInput = z.infer<typeof updateDocumentInput>;

/** `project` is the target project key, or null to make the document organization-wide. */
export const moveDocumentInput = z.object({
  project: z.string().trim().min(1).nullable(),
});

export type MoveDocumentInput = z.infer<typeof moveDocumentInput>;

/** `task` lists a task's documents; `project` a project's, including its tasks'; neither, the whole organization's. */
export const documentListQuery = z.object({
  project: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
});

export const invitationRoleSchema = z.enum(["admin", "member", "guest"]);

export const createInvitationInput = z.object({
  role: invitationRoleSchema.default("member"),
  expiresInDays: z.number().int().min(1, "At least 1 day").max(30, "At most 30 days").default(7),
  maxUses: z.number().int().min(1, "At least 1").max(1000, "At most 1000").nullish(),
});

export type CreateInvitationInput = z.input<typeof createInvitationInput>;

export const invitationCodeInput = z.object({
  code: z.string().trim().min(1, "Enter an invitation code").max(40),
});

/**
 * Task filters of a project page (ST-15); every key is optional and values within a key are
 * OR-ed, keys are AND-ed. `assignee` takes actor ids plus `me` (the viewer) and `none` (unassigned).
 */
export const viewFiltersSchema = z.object({
  status: z.array(z.uuid()).max(50).optional(),
  assignee: z.array(z.union([z.literal("me"), z.literal("none"), z.uuid()])).max(50).optional(),
  priority: z.array(prioritySchema).max(5).optional(),
  tag: z.array(z.uuid()).max(50).optional(),
  q: z.string().trim().max(200).optional(),
});

export type ViewFilters = z.infer<typeof viewFiltersSchema>;

export const viewKindSchema = z.enum(["board", "list"]);

const viewName = z.string().trim().min(1, "Required").max(60, "At most 60 characters");

export const createSavedViewInput = z.object({
  name: viewName,
  filters: viewFiltersSchema.default({}),
  shared: z.boolean().default(false),
  view: viewKindSchema.default("board"),
});

export type CreateSavedViewInput = z.input<typeof createSavedViewInput>;

export const updateSavedViewInput = z
  .object({
    name: viewName.optional(),
    filters: viewFiltersSchema.optional(),
    shared: z.boolean().optional(),
    view: viewKindSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateSavedViewInput = z.infer<typeof updateSavedViewInput>;
