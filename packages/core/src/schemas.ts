import { z } from "zod";
import { parseRepoRemote } from "./remotes";

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

export const statusCategorySchema = z.enum(["backlog", "todo", "in_progress", "in_review", "done", "canceled"]);

const gitAutomationTarget = statusCategorySchema.nullable();

/** A project's status automation from pull request events (ST-85); see GitAutomationSettings. */
export const gitAutomationSchema = z.strictObject({
  enabled: z.boolean(),
  draft: gitAutomationTarget,
  opened: gitAutomationTarget,
  merged: gitAutomationTarget,
  closed: gitAutomationTarget,
});

/** Changes to it: only the fields given change. */
export const gitAutomationInput = gitAutomationSchema
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type GitAutomationInput = z.infer<typeof gitAutomationInput>;

/** The key can't change: it is part of every task key. */
export const updateProjectInput = z
  .object({
    name: projectName.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /** One of the project's own (project-level) documents as its rules for agents; null clears it. */
    rulesDocumentId: z.uuid("A document id").nullable().optional(),
    /** Status automation from pull request events (ST-85); null goes back to the defaults. */
    gitAutomation: gitAutomationInput.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

/** Task kinds (ST-90); each has its own workflow of statuses in every project. */
export const taskKindSchema = z.enum(["task", "release", "milestone"]);

export const TASK_KINDS = taskKindSchema.options;


const statusName = z.string().trim().min(1, "Required").max(40, "At most 40 characters");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "A hex colour like #22c55e");
/** Index in the kind's workflow, from 0; past the end means last. */
const statusPosition = z.number().int().min(0).max(1000);

/** A new status in one kind's workflow (ST-90); appended unless `position` is given. Its category can't change later. */
export const createStatusInput = z.object({
  kind: taskKindSchema.default("task"),
  name: statusName,
  category: statusCategorySchema,
  color: hexColor.nullable().optional(),
  position: statusPosition.optional(),
});

export type CreateStatusInput = z.input<typeof createStatusInput>;

/** Rename, recolor (null clears) or move a status within its workflow (ST-90). */
export const updateStatusInput = z
  .object({ name: statusName, color: hexColor.nullable(), position: statusPosition })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateStatusInput = z.infer<typeof updateStatusInput>;

/** Deleting a status first moves its tasks to `moveTo`, another status of the same workflow (ST-90). */
export const deleteStatusInput = z.object({ moveTo: z.uuid("The id of the status to move its tasks to") });

export type DeleteStatusInput = z.infer<typeof deleteStatusInput>;

export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const taskTitle = z.string().trim().min(1, "Required").max(255, "At most 255 characters");
const taskDescription = z.string().max(50_000).nullable();

/** A calendar date, "YYYY-MM-DD", with no time or time zone (ST-91); null clears it. */
export const taskDateSchema = z.iso.date("A date as YYYY-MM-DD").nullable();

export const DATES_OUT_OF_ORDER = "The start date must be on or before the target date";

/** Start ≤ target when both are set; ISO dates compare as strings. */
export const datesInOrder = (start: string | null | undefined, target: string | null | undefined) =>
  !start || !target || start <= target;

/** Today's date in UTC, "YYYY-MM-DD": what "overdue" compares target dates with. */
export const todayUtc = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/** The target date has passed (before `today`, UTC) and the task isn't closed (done or canceled). */
export const isOverdue = (
  task: { targetDate: string | null },
  category: string | null | undefined,
  today: string = todayUtc(),
) => task.targetDate !== null && task.targetDate < today && category !== "done" && category !== "canceled";

export const createTaskInput = z
  .object({
    /** Default "task"; it can't change later (ST-90). */
    kind: taskKindSchema.optional(),
    title: taskTitle,
    description: taskDescription.optional(),
    statusId: z.uuid().optional(),
    priority: prioritySchema.optional(),
    assigneeIds: z.array(z.uuid()).max(20).optional(),
    tagIds: z.array(z.uuid()).max(20).optional(),
    parentId: z.uuid().nullable().optional(),
    startDate: taskDateSchema.optional(),
    targetDate: taskDateSchema.optional(),
    /** A milestone of the same project to put the task in (ST-96); tasks only. */
    milestoneId: z.uuid().nullable().optional(),
  })
  .refine((v) => datesInOrder(v.startDate, v.targetDate), { message: DATES_OUT_OF_ORDER, path: ["targetDate"] });

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
    startDate: taskDateSchema,
    targetDate: taskDateSchema,
    /** Marks a task as having no code to ship (ST-93), so it needs no release. */
    noCode: z.boolean(),
    /** Puts the task in a milestone of its project (ST-96); null takes it out (it may still inherit its parent's). */
    milestoneId: z.uuid().nullable(),
  })
  .partial();

export type UpdateTaskInput = z.infer<typeof updateTaskInput>;

const filterValue = z.string().trim().min(1).max(100);

/** How a task list's tag filter combines several tags: the task carries every one, or at least one. */
export const tagMatchSchema = z.enum(["all", "any"]);

export type TagMatch = z.infer<typeof tagMatchSchema>;

/**
 * Server-side filters of a project's task list (API query, MCP, CLI). Values within `status`,
 * `assignee` and `priority` are OR-ed; `tags` per `tagMatch` (default every one); keys are AND-ed.
 */
export const taskListFilters = z.object({
  /** Only tasks of this kind (ST-90); status names and categories then match its workflow only. */
  kind: taskKindSchema.optional(),
  /** Status ids, names or categories ("In Progress", "in_progress"), case-insensitive. */
  status: z.array(filterValue).max(50).optional(),
  /** Actor ids, handles (with or without "@", deactivated ones too), "me", "mine" or "none". */
  assignee: z.array(filterValue).max(50).optional(),
  /** Tag names, case-insensitive (with or without "#"). */
  tags: z.array(filterValue).max(20).optional(),
  /** "all" (default): the task carries every tag; "any": at least one. */
  tagMatch: tagMatchSchema.optional(),
  /** 0–4; numeric strings too, as they arrive in a query string. */
  priority: z
    .array(z.union([prioritySchema, z.enum(["0", "1", "2", "3", "4"]).transform(Number).pipe(prioritySchema)]))
    .max(5)
    .optional(),
  /** Case-insensitive text in the title. */
  q: z.string().trim().max(200).optional(),
  /** Direct sub-tasks of this task key ("ST-3"). */
  parent: z.string().trim().min(1).max(30).optional(),
  /** true: only overdue tasks (see `isOverdue`); "true"/"false" too, as they arrive in a query string. */
  overdue: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
});

export type TaskListFilters = z.input<typeof taskListFilters>;

/** Most tasks one bulk update may touch, whether given as keys or matched by a filter (ST-106). */
export const MAX_BULK_TASKS = 100;

/**
 * What a bulk update changes on every task. `status` is a status id, name or category, matched in
 * each task's own project and kind's workflow (keys may span projects); assignees and tags replace the lists.
 */
export const bulkTaskChanges = z
  .object({
    status: filterValue,
    priority: prioritySchema,
    assigneeIds: z.array(z.uuid()).max(20),
    tagIds: z.array(z.uuid()).max(20),
    parentId: z.uuid().nullable(),
    startDate: taskDateSchema,
    targetDate: taskDateSchema,
    noCode: z.boolean(),
    milestoneId: z.uuid().nullable(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

/** The tasks of one project matching the list filters (see `taskListFilters`). */
export const bulkTaskFilter = taskListFilters.extend({ project: z.string().trim().min(1).max(10) });

/** Either `keys` or `filter`; `dryRun` reports what would happen without changing anything. */
export const bulkUpdateTasksInput = z
  .object({
    keys: z
      .array(z.string().trim().min(1).max(30))
      .min(1)
      .max(MAX_BULK_TASKS, `At most ${MAX_BULK_TASKS} tasks per update`)
      .optional(),
    filter: bulkTaskFilter.optional(),
    set: bulkTaskChanges,
    dryRun: z.boolean().optional(),
  })
  .refine((v) => (v.keys === undefined) !== (v.filter === undefined), "Pass either keys or a filter");

export type BulkUpdateTasksInput = z.input<typeof bulkUpdateTasksInput>;

/** Parses "SPI-12" into its project key and number. */
export function parseTaskKey(value: string): { projectKey: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { projectKey: match[1].toUpperCase(), number: Number(match[2]) };
}

/**
 * Words with a meaning in assignee filters ("me" the viewer, "mine" the viewer's person and their
 * agents, "none" unassigned), "github", the GitHub bot's handle (ST-82), and "spider", the Spider
 * Tracker bot's (ST-96); no other actor may take them.
 */
export const RESERVED_HANDLES: readonly string[] = ["me", "mine", "none", "github", "spider"];

/** A handle as typed in a filter or a command: trimmed, without a leading "@", lowercase. */
export const normalizeHandle = (value: string) => value.trim().replace(/^@/, "").toLowerCase();

const agentName = z.string().trim().min(1, "Required").max(80, "At most 80 characters");
const agentHandle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single dashes")
  .max(32)
  .refine((v) => !RESERVED_HANDLES.includes(v), `"me", "mine", "none", "github" and "spider" are reserved`);

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

/**
 * A comment on a document (ST-118); `quote` is the fragment it is about (top-level comments only),
 * which must occur in the document's current text.
 */
export const createDocumentCommentInput = createCommentInput.extend({
  quote: z.string().trim().min(1, "Required").max(2_000, "At most 2,000 characters").nullable().optional(),
});

export type CreateDocumentCommentInput = z.infer<typeof createDocumentCommentInput>;

/** Marks a document comment thread resolved, or reopens it. */
export const resolveDocumentCommentInput = z.object({ resolved: z.boolean() });

export type ResolveDocumentCommentInput = z.infer<typeof resolveDocumentCommentInput>;

export const INBOX_KINDS = [
  "mention",
  "assigned",
  "comment",
  "reply",
  "rules",
  "document_mention",
  "document_comment",
  "document_reply",
] as const;

/** Task notifications: what the inbox returns when `kinds` isn't given (clients from before ST-111 expect a task). */
export const TASK_INBOX_KINDS = ["mention", "assigned", "comment", "reply"] as const;

export const inboxQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  // Query strings: "true"/"1" mean yes (z.coerce.boolean would read "false" as true).
  unread: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Which kinds to return, as a list or comma-separated; default: the task kinds (no `rules` or `document_*`). */
  kinds: z
    .preprocess(
      (v) => (typeof v === "string" ? v.split(",").map((k) => k.trim()).filter(Boolean) : v),
      z.array(z.enum(INBOX_KINDS)).min(1),
    )
    .default([...TASK_INBOX_KINDS]),
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

/** Marks a task as a duplicate of `of` (ST-114); `comment` is appended to the automatic one. */
export const markDuplicateInput = z.object({
  /** The original task's key, e.g. "ST-12". */
  of: z.string().trim().min(1),
  comment: z.string().trim().max(10_000, "At most 10,000 characters").optional(),
});

export type MarkDuplicateInput = z.infer<typeof markDuplicateInput>;

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

/**
 * One partial edit of a document's content (ST-116): replace a fragment (`old` must occur
 * exactly once, or pass `all`), `append` to the end, or replace a Markdown `section`'s body
 * (the text under the heading up to the next heading of the same or a higher level).
 */
export const documentEditSchema = z.union(
  [
    z.strictObject({ old: z.string(), new: z.string(), all: z.boolean().optional() }),
    z.strictObject({ append: z.string() }),
    z.strictObject({ section: z.string(), content: z.string() }),
  ],
  { error: "Each edit is { old, new, all? }, { append } or { section, content }" },
);

export type DocumentEdit = z.infer<typeof documentEditSchema>;

/**
 * Partial edits, applied in order and saved as one new version. With `baseVersion` they fail
 * on a newer save; without it they apply to the current version (atomically, under a lock),
 * failing when a fragment or section isn't there.
 */
export const editDocumentInput = z.object({
  baseVersion: z.number().int().positive().optional(),
  edits: z.array(documentEditSchema).min(1, "At least one edit").max(100, "At most 100 edits"),
});

export type EditDocumentInput = z.infer<typeof editDocumentInput>;

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

/** Which saved versions to compare (ST-117); without `to`, the current one. Query strings are coerced. */
export const documentDiffQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive().optional(),
});
export type DocumentDiffQuery = { from: number; to?: number };

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
 * OR-ed, except `tag`, which follows `tagMatch`; keys are AND-ed. `assignee` takes actor ids plus
 * `me` (the viewer), `mine` (the viewer's person and their agents) and `none` (unassigned).
 * Views store `tagMatch` explicitly ("all" when left out); views saved before it existed have
 * none and are read as "any", the web's match back then. `overdue` (ST-91): only open tasks past their target date.
 */
export const viewFiltersSchema = z.object({
  status: z.array(z.uuid()).max(50).optional(),
  assignee: z.array(z.union([z.literal("me"), z.literal("mine"), z.literal("none"), z.uuid()])).max(50).optional(),
  priority: z.array(prioritySchema).max(5).optional(),
  tag: z.array(z.uuid()).max(50).optional(),
  tagMatch: tagMatchSchema.optional(),
  q: z.string().trim().max(200).optional(),
  overdue: z.boolean().optional(),
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

// Repos and apps (ST-92).

/** A GitHub remote: a URL as `git remote -v` prints it ("https://github.com/o/r.git", "git@github.com:o/r.git") or "o/r". */
export const repoRemoteSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(300, "At most 300 characters")
  .transform((value, ctx) => {
    const remote = parseRepoRemote(value);
    if (!remote) {
      ctx.addIssue({
        code: "custom",
        message: 'A GitHub repo: "owner/name", https://github.com/owner/name or git@github.com:owner/name.git',
      });
      return z.NEVER;
    }
    return remote;
  });

/** Git branch names (simplified): letters, digits, ".", "_", "-" and "/" between parts. */
const BRANCH_NAME = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9_][A-Za-z0-9._/-]*(?<![/.])$/;

/** A branch name as git allows it (simplified): letters, digits, ".", "_", "-" and "/" between parts. */
export const branchNameSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(100, "At most 100 characters")
  .regex(BRANCH_NAME, "A git branch name, e.g. main");

/** A folder in the repo, relative to its root ("web/app"; "." for the whole repo); "./" and a trailing "/" are dropped. */
export const repoPathSchema = z
  .string()
  .trim()
  .max(200, "At most 200 characters")
  .transform((value) => value.replace(/^\.\/(?=.)/, "").replace(/(?<=.)\/+$/, ""))
  .refine((value) => value !== "", "Required")
  .refine(
    (value) => value === "." || value.split("/").every((part) => /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/.test(part)),
    'A relative path in the repo, e.g. "web/app" ("." for the whole repo)',
  );

/** App and environment names: lower-case, part of release tags ("web-2026.10.12"). */
const appSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Required")
  .max(30, "At most 30 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single dashes");

export const appVersioningSchema = z.enum(["date", "semver"]);

const uniqueList = <T extends z.ZodType<string>>(item: T, max: number, what: string) =>
  z
    .array(item)
    .max(max, `At most ${max} ${what}`)
    .refine((list) => new Set(list).size === list.length, `Each ${what.replace(/s$/, "")} only once`);

/** Deploy order, e.g. ["staging", "prod"]; empty when a release is the only "deploy" (a CLI). */
export const appEnvironmentsSchema = uniqueList(appSlug, 10, "environments");

/** Shared packages an app depends on, e.g. ["packages/core"]. */
export const sharedPathsSchema = uniqueList(repoPathSchema, 20, "shared paths");

export const createRepoInput = z.object({
  /** The remote: a GitHub URL or "owner/name". */
  url: repoRemoteSchema,
  /** Default "main". */
  defaultBranch: branchNameSchema.optional(),
  /** Project keys to attach it to. */
  projects: z.array(projectKeySchema).max(50).optional(),
});

export type CreateRepoInput = z.input<typeof createRepoInput>;

export const updateRepoInput = z
  .object({
    /** A new remote, e.g. after the repo was renamed or moved on GitHub. */
    url: repoRemoteSchema.optional(),
    defaultBranch: branchNameSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateRepoInput = z.input<typeof updateRepoInput>;

export const attachRepoInput = z.object({
  /** The repo: "owner/name" or its remote URL. */
  repo: z.string().trim().min(1, "Required").max(300),
});

export type AttachRepoInput = z.input<typeof attachRepoInput>;

/** `POST /tasks/:key/pull-request` (ST-87): opens a pull request for the task on GitHub. */
export const openPullRequestInput = z.object({
  /** The repo ("owner/name" or a remote URL), one of those attached to the task's project; needed only when it has several. */
  repo: z.string().trim().min(1, "Required").max(300).optional(),
  /** The branch with the changes, already pushed to GitHub; default the task's branch ("st-12-short-title"). */
  head: z.string().trim().min(1, "Required").max(255, "At most 255 characters").regex(BRANCH_NAME, "A git branch name, e.g. st-12-fix").optional(),
  /** The branch to merge into; default the repo's default branch. */
  base: branchNameSchema.optional(),
  /** Default: the task's title and key, e.g. "Fix the login (ST-12)". */
  title: z.string().trim().min(1, "Required").max(256, "At most 256 characters").optional(),
  /** Markdown; "Closes ST-12" is added when it doesn't close the task already. Default: a link to the task and "Closes ST-12". */
  body: z.string().max(60_000, "At most 60000 characters").optional(),
  /** Open it as a draft. */
  draft: z.boolean().optional(),
});

export type OpenPullRequestInput = z.input<typeof openPullRequestInput>;

export const createAppInput = z.object({
  name: appSlug,
  path: repoPathSchema,
  sharedPaths: sharedPathsSchema.optional(),
  /** Default "semver". */
  versioning: appVersioningSchema.optional(),
  environments: appEnvironmentsSchema.optional(),
});

export type CreateAppInput = z.input<typeof createAppInput>;

export const updateAppInput = z
  .object({
    name: appSlug,
    path: repoPathSchema,
    sharedPaths: sharedPathsSchema,
    versioning: appVersioningSchema,
    environments: appEnvironmentsSchema,
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateAppInput = z.input<typeof updateAppInput>;

// Releases (ST-93): tasks of kind "release" that link repos and apps and include Done tasks.

const DATE_VERSION = /^\d{4}\.(0?[1-9]|1[0-2])\.(0?[1-9]|[12]\d|3[01])(\.\d+)?$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** A version as stored: trimmed, a semver without its leading "v". */
export const normalizeAppVersion = (versioning: "date" | "semver", version: string) =>
  versioning === "semver" ? version.trim().replace(/^v(?=\d)/, "") : version.trim();

/** Why `version` doesn't fit the app's versioning, or null when it does ("2026.10.13", or "1.4.0"). */
export function appVersionProblem(versioning: "date" | "semver", version: string): string | null {
  const value = normalizeAppVersion(versioning, version);
  if (versioning === "date") return DATE_VERSION.test(value) ? null : `"${version}" isn't a date version like 2026.10.13`;
  return SEMVER.test(value) ? null : `"${version}" isn't a semver version like 1.4.0`;
}

const taskKeyRef = z.string().trim().min(1).max(30);

/** An app a release ships and its version, in the app's versioning; its repo is linked too. */
export const releaseAppInput = z.object({
  /** The app's repo, "owner/name". */
  repo: z.string().trim().min(1, "Required").max(300),
  /** The app's name, e.g. "web". */
  app: appSlug,
  version: z.string().trim().min(1, "Required").max(50, "At most 50 characters"),
});

export type ReleaseAppInput = z.input<typeof releaseAppInput>;

const releaseRepos = z.array(z.string().trim().min(1).max(300)).max(20, "At most 20 repos");
const releaseApps = z
  .array(releaseAppInput)
  .max(50, "At most 50 apps")
  .refine(
    (list) => new Set(list.map((a) => `${a.repo.toLowerCase()}:${a.app}`)).size === list.length,
    "Each app only once",
  );
const releaseTaskKeys = z.array(taskKeyRef).max(MAX_BULK_TASKS, `At most ${MAX_BULK_TASKS} tasks at once`);

/**
 * A new release: a task of kind "release" whose title is its name, usually the version
 * ("2026.10.13"). It links `repos` ("owner/name") and `apps` with a version each, and may
 * include Done `tasks` (keys, any project) from the start.
 */
export const createReleaseInput = z
  .object({
    title: taskTitle,
    description: taskDescription.optional(),
    statusId: z.uuid().optional(),
    assigneeIds: z.array(z.uuid()).max(20).optional(),
    startDate: taskDateSchema.optional(),
    targetDate: taskDateSchema.optional(),
    repos: releaseRepos.optional(),
    apps: releaseApps.optional(),
    tasks: releaseTaskKeys.optional(),
  })
  .refine((v) => datesInOrder(v.startDate, v.targetDate), { message: DATES_OUT_OF_ORDER, path: ["targetDate"] });

export type CreateReleaseInput = z.input<typeof createReleaseInput>;

/** Replaces a release's repos or apps (with their versions); apps' repos stay linked. */
export const updateReleaseInput = z
  .object({ repos: releaseRepos, apps: releaseApps })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export type UpdateReleaseInput = z.input<typeof updateReleaseInput>;

/** Task keys to add to (or remove from) a release. */
export const releaseTasksInput = z.object({ tasks: releaseTaskKeys.min(1, "At least one task") });

export type ReleaseTasksInput = z.input<typeof releaseTasksInput>;

/** Releases of a project: by status (id, name or category of the release workflow) or app name. */
export const releaseListFilters = z.object({
  status: z.array(filterValue).max(20).optional(),
  app: z.string().trim().toLowerCase().min(1).max(30).optional(),
});

export type ReleaseListFilters = z.input<typeof releaseListFilters>;

/**
 * Done tasks that could go into a release: with code, in no release, not shipped. `project` narrows
 * to one project; `release` checks the release exists and, when it has repos, leaves out tasks
 * whose linked commits and pull requests are all in other repos (ST-84).
 */
export const releaseCandidatesQuery = z.object({
  project: z.string().trim().min(1).max(10).optional(),
  release: taskKeyRef.optional(),
});

export type ReleaseCandidatesQuery = z.input<typeof releaseCandidatesQuery>;

/**
 * Writes a release's generated changelog into its description (ST-95). `taskApps` names the apps
 * each task touches (task key → app names; the CLI reads them from local git) so the changelog is
 * grouped by app; `force` replaces a changelog block edited by hand.
 */
export const releaseChangelogInput = z.object({
  taskApps: z
    .record(taskKeyRef, z.array(appSlug).max(50))
    .refine((map) => Object.keys(map).length <= 500, "At most 500 tasks")
    .optional(),
  force: z.boolean().optional(),
});

export type ReleaseChangelogInput = z.input<typeof releaseChangelogInput>;

// Deployments (ST-94): a release's app deployed to one of its environments.

/** A git commit SHA, abbreviated (at least 7 hex digits) or full (40, or 64 for SHA-256); stored lower-case. */
export const commitShaSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{7,64}$/, "A git commit SHA: 7 to 64 hex digits, e.g. 3f2c1ab");

/**
 * `POST /releases/:key/deployments`: the release's `app` (by name; `repo` "owner/name" picks one
 * when the release ships apps of that name from several repos) was deployed to `environment`, one
 * of the app's environments, at `commitSha`.
 */
export const recordDeploymentInput = z.object({
  app: appSlug,
  repo: z.string().trim().min(1, "Required").max(300).optional(),
  environment: appSlug,
  commitSha: commitShaSchema,
});

export type RecordDeploymentInput = z.input<typeof recordDeploymentInput>;

/** A release's deployments, optionally of one app or environment. */
export const deploymentListQuery = z.object({
  app: appSlug.optional(),
  environment: appSlug.optional(),
});

export type DeploymentListQuery = z.input<typeof deploymentListQuery>;

// Milestones (ST-96): tasks of kind "milestone" that group tasks of their project.

/**
 * A new milestone: a task of kind "milestone" (Planned unless `statusId` says otherwise). Its goal
 * and "Done when" go in the description; start and target dates place it on the roadmap.
 */
export const createMilestoneInput = z
  .object({
    title: taskTitle,
    description: taskDescription.optional(),
    statusId: z.uuid().optional(),
    assigneeIds: z.array(z.uuid()).max(20).optional(),
    startDate: taskDateSchema.optional(),
    targetDate: taskDateSchema.optional(),
  })
  .refine((v) => datesInOrder(v.startDate, v.targetDate), { message: DATES_OUT_OF_ORDER, path: ["targetDate"] });

export type CreateMilestoneInput = z.input<typeof createMilestoneInput>;

/** A project's milestones: by status (id, name or category of the milestone workflow). */
export const milestoneListFilters = z.object({
  status: z.array(filterValue).max(20).optional(),
});

export type MilestoneListFilters = z.input<typeof milestoneListFilters>;
