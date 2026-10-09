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

export const createProjectInput = z.object({
  name: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
  key: projectKeySchema,
  description: z.string().trim().max(2000).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const taskTitle = z.string().trim().min(1, "Required").max(255, "At most 255 characters");
const taskDescription = z.string().max(50_000).nullable();

export const createTaskInput = z.object({
  title: taskTitle,
  description: taskDescription.optional(),
  statusId: z.uuid().optional(),
  priority: prioritySchema.optional(),
  assigneeIds: z.array(z.uuid()).max(20).optional(),
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
    parentId: z.uuid().nullable(),
    position: taskPositionInput,
  })
  .partial();

export type UpdateTaskInput = z.infer<typeof updateTaskInput>;

/** Parses "SPI-12" into its project key and number. */
export function parseTaskKey(value: string): { projectKey: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { projectKey: match[1].toUpperCase(), number: Number(match[2]) };
}

export const createAgentInput = z.object({
  name: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single dashes")
    .max(32)
    .optional(),
  description: z.string().trim().max(500).optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentInput>;

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
});

export const deviceCodeInput = z.object({
  client_name: z.string().trim().min(1).max(60).default("CLI"),
});
