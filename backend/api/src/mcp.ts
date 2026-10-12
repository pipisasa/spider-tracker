import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ActorContext,
  ActorRef,
  DocumentSummaryDto,
  ProjectDetailDto,
  ProjectRulesDto,
  StatusDto,
  TaskDto,
  TaskKind,
} from "@repo/core";
import { allStatuses, firstStatusOf, kindOf, matchStatuses, unknownStatusMessage, workflowOf } from "@repo/core/statuses";
import {
  DomainError,
  MAX_BULK_TASKS,
  addComment,
  archiveProject,
  authenticateApiKey,
  createDocument,
  diffDocumentVersions,
  editDocument,
  documentDiffView,
  getDocument,
  getDocumentGraph,
  getDocumentVersion,
  listBacklinks,
  listDocuments,
  listTaskBacklinks,
  moveDocument,
  updateDocument,
  createProject,
  createStatus,
  createTask,
  deleteStatus,
  updateStatus,
  getProject,
  getProjectRules,
  getTask,
  INBOX_KINDS,
  listProjectRules,
  listMembers,
  listProjects,
  createTag,
  listComments,
  addRelation,
  markDuplicate,
  listRelations,
  listSubtasks,
  removeRelation,
  listTags,
  listTaskActivity,
  listInbox,
  listTasks,
  markInboxRead,
  updateProject,
  updateTask,
  updateTasks,
  actorHandle,
  commentView,
  documentVersionView,
  relationView,
  taskView,
  webUrls,
  withDocumentUrl,
  withProjectUrl,
  withTaskUrl,
} from "@repo/core";
import type { Db, schema } from "@repo/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Realtime } from "./realtime";
import type { AppEnv } from "./types";

type ActorRow = typeof schema.actors.$inferSelect;
type Key = NonNullable<AppEnv["Variables"]["apiKey"]>;

const priority = z
  .number()
  .int()
  .min(0)
  .max(4)
  .describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");
const tagsInput = z.array(z.string()).max(20).describe("Tag names (see list_tags)");
/** A filter value, or several matched with OR (as repeated API query parameters). */
const oneOrMany = z.union([z.string(), z.array(z.string()).max(50)]);
const tagMatchSchema = z.enum(["all", "any"]);
const dateInput = z.string().describe('A date as "YYYY-MM-DD"');
const startDateInput = dateInput.nullable().describe('Start date, "YYYY-MM-DD"; null clears it');
const targetDateInput = dateInput.nullable().describe('Target date, "YYYY-MM-DD", on or after the start date; null clears it');
const overdueInput = z
  .boolean()
  .describe("true: only tasks past their target date (today = the server's UTC date) that aren't done or canceled");
const kindInput = z
  .enum(["task", "release", "milestone"])
  .describe("Task kind; each has its own workflow of statuses (see get_project workflows)");
const assigneesInput = z
  .array(z.string())
  .max(20)
  .describe('Member handles (e.g. "alice" or "@alice"); "me" means you');

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/** Runs a tool body, turning domain errors into tool errors the model can read and act on. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof DomainError) return { ...text(err.message), isError: true };
    console.error(err);
    return { ...text("Something went wrong"), isError: true };
  }
}

/** Rules longer than this are cut in the server instructions; get_project has them in full. */
const RULES_INSTRUCTIONS_CHARS = 12_000;

/**
 * The server's instructions (ST-111): the rules of the agent's projects, so a new session has
 * them from its first MCP answer (Claude Code puts them in the system prompt).
 */
export function rulesInstructions(handle: string, rules: ProjectRulesDto[]): string | undefined {
  if (rules.length === 0) return undefined;
  return [
    `You are @${handle} in Spider Tracker. Your projects have rules for agents. Follow them when you work on these projects' tasks; they win over your general habits (statuses, where to put results, how to name tasks). get_project returns the current rules, and when they change you get an inbox item of kind "rules".`,
    ...rules.map((r) => {
      const cut = r.content.length > RULES_INSTRUCTIONS_CHARS;
      return [
        "",
        `## Rules of project ${r.projectKey} (${r.projectName}): "${r.title}" (document ${r.documentId}, version ${r.version})`,
        "",
        cut ? r.content.slice(0, RULES_INSTRUCTIONS_CHARS) : r.content,
        ...(cut ? ["", `[Cut here: read the rest with get_document ${r.documentId}.]`] : []),
      ].join("\n");
    }),
  ].join("\n");
}

/** Whether a JSON-RPC request (or batch) starts a session; only then are instructions sent. */
async function isInitialize(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    return (Array.isArray(body) ? body : [body]).some(
      (m: unknown) => typeof m === "object" && m !== null && "method" in m && m.method === "initialize",
    );
  } catch {
    return false;
  }
}

/** Tracker tools for one request, acting as the key's agent inside its organization. */
function createMcpServer(db: Db, key: Key, realtime: Realtime, webOrigin: string, instructions?: string) {
  const ctx: ActorContext = {
    orgId: key.organization.id,
    actorId: key.actor.id,
    role: key.actor.role,
    source: "mcp",
  };
  // Tasks, projects and documents carry their web page's address (ST-115).
  const urls = webUrls(webOrigin, key.organization.slug);

  // Every actor, deactivated ones included, so their past work and assignments still read by handle.
  let actorRows: Promise<ActorRow[]> | undefined;
  const loadActors = () => (actorRows ??= listMembers(db, ctx.orgId, { includeDeactivated: true }));
  const loadMembers = async () => (await loadActors()).filter((m) => !m.deactivatedAt);

  const actorRefs = async (): Promise<ActorRef[]> =>
    (await loadActors()).map((a) => ({ id: a.id, handle: a.handle, deactivated: a.deactivatedAt !== null }));
  const handleOf = async (actorId: string) => actorHandle(await actorRefs(), actorId);

  const resolveAssignees = async (handles: string[]) => {
    const rows = await loadMembers();
    return handles.map((raw) => {
      const handle = raw.trim().replace(/^@/, "").toLowerCase();
      if (handle === "me") return ctx.actorId;
      const member = rows.find((m) => m.handle === handle);
      if (!member) {
        throw new DomainError(
          "validation",
          `Unknown member "${raw}". Valid handles: me, ${rows.map((m) => m.handle).join(", ")}`,
        );
      }
      return member.id;
    });
  };

  /** A status of the workflow of `kind` (ST-90); a category ("in_progress") picks its first status in board order, like the CLI. */
  const resolveStatus = (project: ProjectDetailDto, name: string, kind: TaskKind = "task"): StatusDto => {
    const status = workflowOf(project, kind).find((s) => s.id === name) ?? matchStatuses(project, name, kind)[0];
    if (!status) throw new DomainError("validation", unknownStatusMessage(project, name, kind));
    return status;
  };

  const resolveTags = async (names: string[]) => {
    const rows = await listTags(db, ctx.orgId);
    return names.map((raw) => {
      const tag = rows.find((t) => t.name.toLowerCase() === raw.trim().toLowerCase());
      if (!tag) {
        throw new DomainError(
          "validation",
          `Unknown tag "${raw}". Existing tags: ${rows.map((t) => t.name).join(", ") || "none"} (create_tag adds one)`,
        );
      }
      return tag.id;
    });
  };
  let tagRows: ReturnType<typeof listTags> | undefined;
  const loadTags = () => (tagRows ??= listTags(db, ctx.orgId));

  const projectOfTask = (taskKey: string) => getProject(db, ctx, taskKey.split("-")[0] ?? "");

  // Output shapes are the API DTOs, as the CLI prints them with --json (ST-107; see @repo/core/views).

  /** A task with its status, assignee handles and tag names (TaskView). */
  const describeTask = async (task: TaskDto, project: ProjectDetailDto) => {
    const [actors, tags] = await Promise.all([actorRefs(), task.tagIds.length ? loadTags() : []]);
    return withTaskUrl(urls, taskView(task, { statuses: allStatuses(project), actors, tags }));
  };

  const describeProject = <T extends { key: string }>(project: T) => withProjectUrl(urls, project);

  const describeDocument = <T extends DocumentSummaryDto>(d: T) => withDocumentUrl(urls, d);

  /** A project's rules: ProjectRulesDto with the document's web address, as `spider project view --json`. */
  const describeRules = (r: ProjectRulesDto) => ({ ...r, url: urls.document(r.documentId) });

  const server = new McpServer({ name: "spider-tracker", version: "0.1.0" }, instructions ? { instructions } : undefined);

  server.registerTool(
    "whoami",
    {
      description:
        "Show which agent you are, which organization you act in, and the rules of your projects (follow them). Call it first in a session.",
      inputSchema: {},
    },
    () =>
      run(async () => ({
        organization: { slug: key.organization.slug, name: key.organization.name },
        you: { handle: key.actor.handle, name: key.actor.name, role: key.actor.role },
        projectRules: (await listProjectRules(db, ctx)).map(describeRules),
      })),
  );

  server.registerTool(
    "list_projects",
    { description: "List the organization's projects (key, name, description).", inputSchema: {} },
    () =>
      run(async () =>
        ({ items: (await listProjects(db, ctx)).map(describeProject) }),
      ),
  );

  server.registerTool(
    "get_project",
    {
      description:
        "Get a project, its rules for agents (follow them), its workflows (`workflows`: the statuses of each task kind, task, release and milestone, in board order with their categories; `statuses` is the task workflow) and its documents (read them with get_document).",
      inputSchema: { projectKey: z.string().describe('Project key, e.g. "ST"') },
    },
    ({ projectKey }) =>
      run(async () => {
        const project = await getProject(db, ctx, projectKey);
        const [documents, rules] = await Promise.all([
          listDocuments(db, ctx, { project: project.key }),
          getProjectRules(db, ctx, project.key),
        ]);
        return { ...describeProject(project), rules: rules ? describeRules(rules) : null, documents: documents.map(describeDocument) };
      }),
  );

  const projectName = z.string().describe("Up to 80 characters");
  const projectDescription = z.string().describe("Markdown, up to 2000 characters");

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project with the default workflows: task (Backlog, Todo, In Progress, In Review, Done, Canceled), release (Planned, On staging, Release review, Released, Canceled) and milestone (Planned, Active, Ready to close, Done). Owners, admins and their agents only.",
      inputSchema: {
        key: z
          .string()
          .describe('Project key, 2–10 letters or digits starting with a letter, e.g. "ST"; prefixes every task key'),
        name: projectName,
        description: projectDescription.optional(),
      },
    },
    ({ key: projectKey, name, description }) =>
      run(async () => describeProject(await createProject(db, ctx, { key: projectKey, name, description }))),
  );

  server.registerTool(
    "update_project",
    {
      description:
        "Change a project's name, description or rules document (the key can't change). The rules are one of the project's own documents; agents of the project get them automatically and are notified when they change. Owners, admins and their agents only.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        name: projectName.optional(),
        description: projectDescription.nullable().optional().describe("Markdown; null clears it"),
        rulesDocumentId: z
          .string()
          .nullable()
          .optional()
          .describe("Id of a document in this project (not a task's) to use as its rules; null clears them"),
      },
    },
    ({ projectKey, name, description, rulesDocumentId }) =>
      run(async () => describeProject(await updateProject(db, ctx, projectKey, { name, description, rulesDocumentId }))),
  );

  server.registerTool(
    "archive_project",
    {
      description:
        "Archive a project: it leaves list_projects and takes no new tasks; its tasks stay readable. undo: true restores it. Owners, admins and their agents only.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        undo: z.boolean().optional().describe("Restore an archived project"),
      },
    },
    ({ projectKey, undo }) => run(async () => describeProject(await archiveProject(db, ctx, projectKey, !undo))),
  );

  // Workflow editing (ST-90). Statuses are named by id or name within one kind's workflow.
  const statusRef = z.string().describe("Status name or id");
  const colorInput = z.string().describe("Hex colour like #22c55e");
  const positionInput = z.number().int().min(0).describe("Place in the workflow, from 0; past the end means last");
  const findStatus = async (projectKey: string, kind: TaskKind, ref: string) => {
    const project = await getProject(db, ctx, projectKey);
    const statuses = workflowOf(project, kind);
    const status = statuses.find((s) => s.id === ref) ?? statuses.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());
    if (!status) throw new DomainError("validation", unknownStatusMessage(project, ref, kind));
    return { project, status };
  };

  server.registerTool(
    "create_status",
    {
      description:
        "Add a status to a project's workflow for one task kind (default task), at the end or at position. Its category (backlog, todo, in_progress, in_review, done, canceled) can't change later. Owners, admins and their agents only.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        kind: kindInput.optional(),
        name: z.string().describe("Up to 40 characters, unique in the workflow"),
        category: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "canceled"]),
        color: colorInput.optional(),
        position: positionInput.optional(),
      },
    },
    ({ projectKey, kind, name, category, color, position }) =>
      run(async () => describeProject(await createStatus(db, ctx, projectKey, { kind, name, category, color, position }))),
  );

  server.registerTool(
    "update_status",
    {
      description:
        "Rename, recolor or move a status within its workflow (kind default task). Owners, admins and their agents only.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        kind: kindInput.optional(),
        status: statusRef,
        name: z.string().optional().describe("New name"),
        color: colorInput.nullable().optional().describe("Hex colour like #22c55e; null clears it"),
        position: positionInput.optional(),
      },
    },
    ({ projectKey, kind, status: ref, name, color, position }) =>
      run(async () => {
        const { project, status } = await findStatus(projectKey, kind ?? "task", ref);
        return describeProject(await updateStatus(db, ctx, project.key, status.id, { name, color, position }));
      }),
  );

  server.registerTool(
    "delete_status",
    {
      description:
        "Delete a status from its workflow (kind default task), first moving its tasks to another status of the same workflow. Every workflow keeps at least one open status and one done status. Owners, admins and their agents only.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        kind: kindInput.optional(),
        status: statusRef,
        moveTo: statusRef.describe("Status (name or id) of the same workflow to move its tasks to"),
      },
    },
    ({ projectKey, kind, status: ref, moveTo }) =>
      run(async () => {
        const { project, status } = await findStatus(projectKey, kind ?? "task", ref);
        const target = await findStatus(project.key, kind ?? "task", moveTo);
        const result = await deleteStatus(db, ctx, project.key, status.id, { moveTo: target.status.id });
        // DeleteStatusResponse, as `spider project status delete --json`.
        return { ...result, project: describeProject(result.project) };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks in a project, in board order. Filter by kind, status (a status id, name or category such as todo, in_progress, done), assignee, tags, priority, title text and overdue (target date passed, not done or canceled); status, assignee and priority match any of their values, tags all of them (or any with tagMatch: \"any\"); filters combine with AND.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        kind: kindInput.optional().describe("Only tasks of this kind; status names then match its workflow only (without it, every workflow)"),
        status: oneOrMany.optional().describe('Status id, name ("In Progress") or category ("in_progress"); an array matches any'),
        assignee: oneOrMany
          .optional()
          .describe(
            '"me" (you), "mine" (the person you work for and all their agents, you included), "none" (unassigned) or a member handle, deactivated members too; an array matches any',
          ),
        tags: z.array(z.string()).max(20).optional().describe("Tag names (see list_tags); a task must have all of them unless tagMatch is \"any\""),
        tagMatch: tagMatchSchema.optional().describe('"all" (default): every tag; "any": at least one'),
        priority: z.array(priority).max(5).optional().describe("Any of these priorities: 0 none, 1 urgent, 2 high, 3 medium, 4 low"),
        query: z.string().optional().describe("Case-insensitive text to find in titles"),
        overdue: overdueInput.optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum tasks to return (default 50)"),
      },
    },
    ({ projectKey, kind, status, assignee, tags, tagMatch, priority: priorities, query, overdue, limit }) =>
      run(async () => {
        const project = await getProject(db, ctx, projectKey);
        const tasks = await listTasks(db, ctx, project.key, {
          kind,
          status: status === undefined ? undefined : [status].flat(),
          assignee: assignee === undefined ? undefined : [assignee].flat(),
          tags,
          tagMatch,
          priority: priorities,
          q: query,
          overdue,
        });
        const shown = tasks.slice(0, limit ?? 50);
        return {
          items: await Promise.all(shown.map((t) => describeTask(t, project))),
          total: tasks.length,
        };
      }),
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Get a task by key, with its description, status name, assignee handles, parent, sub-tasks, links and documents.",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) =>
      run(async () => {
        const task = await getTask(db, ctx, taskKey);
        await realtime.presence.touch(ctx, task.key);
        const [subtasks, relations, documents] = await Promise.all([
          listSubtasks(db, ctx, task.key),
          listRelations(db, ctx, task.key),
          listDocuments(db, ctx, { task: task.key }),
        ]);
        // TaskDetailView, as `spider task view --json`.
        return {
          ...(await describeTask(task, await projectOfTask(task.key))),
          subtasks: await Promise.all(subtasks.map(async (t) => describeTask(t, await projectOfTask(t.key)))),
          relations: relations.map(relationView),
          documents: documents.map(describeDocument),
        };
      }),
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task in a project. Defaults to the project's first todo status and no assignees.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        title: z.string(),
        description: z.string().optional().describe("Markdown"),
        status: z.string().optional().describe("Status name; see get_project"),
        priority: priority.optional(),
        assignees: assigneesInput.optional(),
        tags: tagsInput.optional(),
        parent: z.string().optional().describe('Parent task key, e.g. "ST-3", to create a sub-task'),
        startDate: dateInput.optional().describe('Start date, "YYYY-MM-DD"'),
        targetDate: dateInput.optional().describe('Target date, "YYYY-MM-DD", on or after the start date'),
      },
    },
    ({ projectKey, title, description, status, priority, assignees, tags, parent, startDate, targetDate }) =>
      run(async () => {
        const project = await getProject(db, ctx, projectKey);
        const task = await createTask(db, ctx, project.key, {
          title,
          description,
          priority,
          statusId: status ? resolveStatus(project, status).id : undefined,
          assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
          tagIds: tags ? await resolveTags(tags) : undefined,
          parentId: parent ? (await getTask(db, ctx, parent)).id : undefined,
          startDate,
          targetDate,
        });
        return describeTask(task, project);
      }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Update a task. Only the fields you pass change; assignees and tags replace the whole list.",
      inputSchema: {
        key: z.string().describe('Task key, e.g. "ST-12"'),
        title: z.string().optional(),
        description: z.string().nullable().optional().describe("Markdown; null clears it"),
        status: z.string().optional().describe("Status name or category, in the workflow of the task's kind; see get_project"),
        priority: priority.optional(),
        assignees: assigneesInput.optional(),
        tags: tagsInput.optional(),
        parent: z.string().nullable().optional().describe('Parent task key; null makes it a top-level task'),
        startDate: startDateInput.optional(),
        targetDate: targetDateInput.optional(),
      },
    },
    ({ key: taskKey, title, description, status, priority, assignees, tags, parent, startDate, targetDate }) =>
      run(async () => {
        const project = await projectOfTask(taskKey);
        // A status is matched in the workflow of the task's kind.
        const kind = status ? kindOf(await getTask(db, ctx, taskKey)) : "task";
        const task = await updateTask(db, ctx, taskKey, {
          title,
          description,
          priority,
          statusId: status ? resolveStatus(project, status, kind).id : undefined,
          assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
          tagIds: tags ? await resolveTags(tags) : undefined,
          parentId: parent === undefined ? undefined : parent === null ? null : (await getTask(db, ctx, parent)).id,
          startDate,
          targetDate,
        });
        return describeTask(task, project);
      }),
  );

  server.registerTool(
    "update_tasks",
    {
      description: `Update several tasks at once: by keys (any projects) or by a filter in one project, at most ${MAX_BULK_TASKS}. Only the fields you pass change; assignees and tags replace the whole list. Returns one result per task (changed, unchanged or error with the reason); one task failing doesn't stop the others. Use dryRun to see what would change first.`,
      inputSchema: {
        keys: z.array(z.string()).min(1).max(MAX_BULK_TASKS).optional().describe('Task keys, e.g. ["ST-2", "ST-3"]; or use filter'),
        filter: z
          .object({
            projectKey: z.string().describe('Project key, e.g. "ST"'),
            kind: kindInput.optional().describe("Only tasks of this kind"),
            parent: z.string().optional().describe('Only direct sub-tasks of this task key, e.g. "ST-1"'),
            status: oneOrMany.optional().describe("Current status: id, name or category; an array matches any"),
            assignee: oneOrMany.optional().describe('"me", "mine", "none" or a handle; an array matches any'),
            tags: z.array(z.string()).max(20).optional().describe('Tag names; all of them unless tagMatch is "any"'),
            tagMatch: tagMatchSchema.optional(),
            priority: z.array(priority).max(5).optional().describe("Any of these priorities"),
            query: z.string().optional().describe("Case-insensitive text to find in titles"),
            overdue: overdueInput.optional(),
          })
          .optional()
          .describe(`Tasks to change, as in list_tasks; fails if more than ${MAX_BULK_TASKS} match`),
        status: z.string().optional().describe("New status name or category, matched in each task's project and kind's workflow; see get_project"),
        priority: priority.optional(),
        assignees: assigneesInput.optional(),
        tags: tagsInput.optional(),
        parent: z.string().nullable().optional().describe("New parent task key; null makes them top-level tasks"),
        startDate: startDateInput.optional(),
        targetDate: targetDateInput.optional(),
        dryRun: z.boolean().optional().describe("Report what would change without changing anything"),
      },
    },
    ({ keys, filter, status, priority, assignees, tags, parent, startDate, targetDate, dryRun }) =>
      run(async () => {
        const result = await updateTasks(db, ctx, {
          keys,
          filter: filter && {
            project: filter.projectKey,
            kind: filter.kind,
            parent: filter.parent,
            status: filter.status === undefined ? undefined : [filter.status].flat(),
            assignee: filter.assignee === undefined ? undefined : [filter.assignee].flat(),
            tags: filter.tags,
            tagMatch: filter.tagMatch,
            priority: filter.priority,
            q: filter.query,
            overdue: filter.overdue,
          },
          set: {
            status,
            priority,
            assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
            tagIds: tags ? await resolveTags(tags) : undefined,
            parentId: parent === undefined ? undefined : parent === null ? null : (await getTask(db, ctx, parent)).id,
            startDate,
            targetDate,
          },
          dryRun,
        });
        const projects = new Map<string, Promise<ProjectDetailDto>>();
        const projectOf = (taskKey: string) => {
          const projectKey = taskKey.split("-")[0] ?? "";
          let project = projects.get(projectKey);
          if (!project) {
            project = getProject(db, ctx, projectKey);
            projects.set(projectKey, project);
          }
          return project;
        };
        return {
          ...result,
          results: await Promise.all(
            result.results.map(async (r) => ({ ...r, task: r.task && (await describeTask(r.task, await projectOf(r.task.key))) })),
          ),
        };
      }),
  );

  /** Adds you to a task's assignees and optionally moves it. */
  const takeTask = async (taskKey: string, moveToInProgress: boolean) => {
    const project = await projectOfTask(taskKey);
    const current = await getTask(db, ctx, taskKey);
    let statusId: string | undefined;
    if (moveToInProgress) {
      const kind = kindOf(current);
      const status = firstStatusOf(project, "in_progress", kind);
      if (!status) throw new DomainError("validation", `${project.key}${kind === "task" ? "" : `'s ${kind} workflow`} has no in-progress status`);
      statusId = status.id;
    }
    const assigneeIds = current.assigneeIds.includes(ctx.actorId)
      ? current.assigneeIds
      : [...current.assigneeIds, ctx.actorId];
    const task = await updateTask(db, ctx, current.key, { assigneeIds, statusId });
    await realtime.presence.touch(ctx, task.key);
    return describeTask(task, project);
  };

  server.registerTool(
    "assign_to_me",
    {
      description: "Add yourself to a task's assignees (others stay assigned).",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) => run(() => takeTask(taskKey, false)),
  );

  server.registerTool(
    "start_task",
    {
      description: "Start working on a task: assign it to yourself and move it to the first in-progress status of its workflow.",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) => run(() => takeTask(taskKey, true)),
  );

  const relationKind = z
    .enum(["blocks", "blocked_by", "relates", "duplicates", "duplicated_by"])
    .describe('How the other task relates to this one, from this task\'s side: "blocks" means this task blocks the other');

  server.registerTool(
    "link_tasks",
    {
      description: "Link two tasks: blocks / blocked_by, relates, duplicates / duplicated_by.",
      inputSchema: {
        key: z.string().describe('This task, e.g. "ST-12"'),
        kind: relationKind,
        task: z.string().describe('The other task, e.g. "ST-15"'),
      },
    },
    ({ key: taskKey, kind, task }) =>
      run(async () => {
        const link = await addRelation(db, ctx, taskKey, { kind, task });
        return { [taskKey.toUpperCase()]: `${link.kind} ${link.task.key}` };
      }),
  );

  server.registerTool(
    "unlink_tasks",
    {
      description: "Remove a link between two tasks (same arguments as link_tasks).",
      inputSchema: { key: z.string(), kind: relationKind, task: z.string() },
    },
    ({ key: taskKey, kind, task }) => run(async () => ((await removeRelation(db, ctx, taskKey, { kind, task })), { removed: true })),
  );

  server.registerTool(
    "mark_duplicate",
    {
      description:
        "Mark a task as a duplicate of another in one step: link it (duplicates), move it to the first canceled status of its workflow and comment \"Duplicate of KEY\". Calling it again changes nothing; a task can't duplicate itself, close a cycle of duplicates, or duplicate a second original (unlink_tasks first).",
      inputSchema: {
        key: z.string().describe('The duplicate, e.g. "ST-12"'),
        of: z.string().describe('The original task, e.g. "ST-9"'),
        comment: z.string().optional().describe("Markdown added below the automatic comment"),
      },
    },
    ({ key: taskKey, of, comment }) =>
      run(async () => {
        const task = await markDuplicate(db, ctx, taskKey, { of, comment });
        return describeTask(task, await projectOfTask(task.key));
      }),
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List documents (specs, plans, reports) without their content, most recently updated first. Pass a task, a project (includes its tasks' documents) or neither for the whole organization.",
      inputSchema: {
        project: z.string().optional().describe('Project key, e.g. "ST"'),
        task: z.string().optional().describe('Task key, e.g. "ST-12"'),
      },
    },
    ({ project, task }) =>
      run(async () => ({ items: (await listDocuments(db, ctx, { project, task })).map(describeDocument) })),
  );

  server.registerTool(
    "get_document",
    {
      description:
        "Read a document's content (Markdown or HTML). Its `version` is the baseVersion to pass to update_document. Pass `version` to read an older version.",
      inputSchema: {
        id: z.string().describe("Document id"),
        version: z.number().int().positive().optional().describe("An older version number"),
      },
    },
    ({ id, version }) =>
      run(async () => {
        const document = await getDocument(db, ctx, id);
        if (version === undefined || version === document.version) return describeDocument(document);
        return documentVersionView(describeDocument(document), await getDocumentVersion(db, ctx, id, version));
      }),
  );

  server.registerTool(
    "diff_document",
    {
      description:
        "What changed in a document between two saved versions, as a unified diff of its lines (Markdown or HTML source). Omit `to` to compare with the current version. Use it to check what an agent changed; list_documents and get_document show the current version.",
      inputSchema: {
        id: z.string().describe("Document id"),
        from: z.number().int().positive().describe("The older version number"),
        to: z.number().int().positive().optional().describe("The newer version number; omit for the current version"),
      },
    },
    ({ id, from, to }) =>
      run(async () => {
        // DocumentDiffView, as `spider doc diff --json`.
        return documentDiffView(await diffDocumentVersions(db, ctx, id, { from, to }));
      }),
  );

  server.registerTool(
    "create_document",
    {
      description:
        "Create a document: organization-wide, in a project, or on a task (the task's project is implied). Markdown by default. Link other documents with [[Title]] or [[Title|label]], by id with [[doc:<id>]] (survives renames, shows the current title) and tasks with [[ST-12]]; they show as backlinks and in the documents graph. The result's url is the document's web page.",
      inputSchema: {
        title: z.string(),
        content: z.string().optional().describe("Markdown (or HTML with format html); at most 1 MB"),
        format: z.enum(["md", "html"]).optional(),
        project: z.string().optional().describe('Project key, e.g. "ST"'),
        task: z.string().optional().describe('Task key, e.g. "ST-12"'),
      },
    },
    ({ title, content, format, project, task }) =>
      run(async () => {
        const document = await createDocument(db, ctx, { title, content, format, project, task });
        return describeDocument(document);
      }),
  );

  server.registerTool(
    "list_backlinks",
    {
      description:
        "Follow the knowledge base backwards: the documents linking to a document ([[its title]] or [[doc:<id>]]), or mentioning a task ([[ST-12]] or a plain ST-12; not the task's own documents). Most recently updated first. Pass id or task.",
      inputSchema: {
        id: z.string().optional().describe("Document id"),
        task: z.string().optional().describe('Task key, e.g. "ST-12"'),
      },
    },
    ({ id, task }) =>
      run(async () => {
        if (!id === !task) throw new DomainError("validation", "Pass either id (a document) or task (a task key)");
        const documents = task ? await listTaskBacklinks(db, ctx, task) : await listBacklinks(db, ctx, id ?? "");
        // { items } of document summaries, as `spider doc backlinks --json`.
        return { items: documents.map(describeDocument) };
      }),
  );

  server.registerTool(
    "get_document_graph",
    {
      description:
        "The documents you can see as a graph: documents, the tasks and projects they sit in or link to, and every link (from a document to a document, a task, or a title no document has yet: unresolved). A task document belongs to its task, a task to its project.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        // DocumentGraphDto with urls, as GET …/documents/graph and `spider doc graph --json`.
        const graph = await getDocumentGraph(db, ctx);
        return {
          ...graph,
          documents: graph.documents.map(describeDocument),
          tasks: graph.tasks.map((t) => withTaskUrl(urls, t)),
          projects: graph.projects.map(describeProject),
        };
      }),
  );

  server.registerTool(
    "update_document",
    {
      description:
        "Save a new version of a document. Only the fields you pass change; content replaces the whole text (to change part of it, use edit_document). Fails if someone saved since baseVersion: read it again with get_document and reapply your edit. A new title rewrites [[Old title]] links in the documents you can edit that link here (relinked lists them, and any skipped).",
      inputSchema: {
        id: z.string().describe("Document id"),
        baseVersion: z.number().int().positive().describe("The version you read (from get_document)"),
        title: z.string().optional(),
        content: z.string().optional().describe("The full new content"),
        format: z.enum(["md", "html"]).optional(),
      },
    },
    ({ id, baseVersion, title, content, format }) =>
      run(async () => {
        // UpdatedDocumentDto: the document, plus `relinked` when a new title rewrote links to it.
        return describeDocument(await updateDocument(db, ctx, id, { baseVersion, title, content, format }));
      }),
  );

  server.registerTool(
    "edit_document",
    {
      description:
        "Change part of a document without resending it: replace a fragment ({ old, new }; old must occur exactly once, or pass all: true), append text ({ append }), or replace a Markdown section's body ({ section: \"## Heading\", content }: up to the next heading of the same or a higher level; the heading stays). Edits apply in order and save one new version. Without baseVersion they apply to the current version and fail if a fragment or section isn't there (a conflict: read the document again); with baseVersion they fail if anyone saved since.",
      inputSchema: {
        id: z.string().describe("Document id"),
        baseVersion: z.number().int().positive().optional().describe("The version you read; omit to edit the current version"),
        edits: z
          .array(
            z.union([
              z.strictObject({
                old: z.string().describe("Exact text to replace"),
                new: z.string().describe("Replacement text"),
                all: z.boolean().optional().describe("Replace every occurrence"),
              }),
              z.strictObject({ append: z.string().describe("Text added at the end, on a new line") }),
              z.strictObject({
                section: z.string().describe('Heading of the section, e.g. "## Decisions"'),
                content: z.string().describe("The section's new body, without the heading"),
              }),
            ]),
          )
          .min(1),
      },
    },
    ({ id, baseVersion, edits }) =>
      run(async () => {
        const document = await editDocument(db, ctx, id, { baseVersion, edits });
        return describeDocument(document);
      }),
  );

  server.registerTool(
    "move_document",
    {
      description:
        "Move a document to another project, or make it organization-wide (project null). Keeps its id and versions; a task document leaves its task. Needs access to both projects.",
      inputSchema: {
        id: z.string().describe("Document id"),
        project: z.string().nullable().describe('Target project key, or null for organization-wide'),
      },
    },
    ({ id, project }) => run(async () => describeDocument(await moveDocument(db, ctx, id, { project }))),
  );

  server.registerTool(
    "list_comments",
    {
      description: "Read the comments under a task, oldest first, with author handles.",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) =>
      run(async () => {
        const comments = await listComments(db, ctx, taskKey);
        await realtime.presence.touch(ctx, taskKey);
        const actors = await actorRefs();
        return { items: comments.map((c) => commentView(c, actors)) };
      }),
  );

  server.registerTool(
    "get_task_activity",
    {
      description:
        "A task's history, oldest first: who created it, changed which fields (status and assignees as names) and commented, and from where (ui, api, mcp, cli).",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) =>
      run(async () => {
        const project = await projectOfTask(taskKey);
        const statusName = (id: unknown) => allStatuses(project).find((s) => s.id === id)?.name ?? id;
        const handles = async (ids: unknown) => (Array.isArray(ids) ? Promise.all(ids.map((id) => handleOf(String(id)))) : ids);
        return Promise.all(
          (await listTaskActivity(db, ctx, taskKey)).map(async (e) => {
            const changes: Record<string, unknown> = { ...e.changes };
            const pair = (v: unknown) => (Array.isArray(v) ? v : [undefined, v]);
            if (changes.statusId !== undefined) {
              const [from, to] = pair(changes.statusId);
              changes.status = from === undefined ? statusName(to) : [statusName(from), statusName(to)];
              delete changes.statusId;
            }
            if (changes.assigneeIds !== undefined) {
              const [from, to] = pair(changes.assigneeIds);
              changes.assignees = from === undefined ? await handles(to) : [await handles(from), await handles(to)];
              delete changes.assigneeIds;
            }
            return { action: e.action, by: await handleOf(e.actorId), via: e.source, at: e.createdAt, changes };
          }),
        );
      }),
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Comment on a task (Markdown). Mention people or agents with @handle to notify them; set parent_id to reply to a comment. Agents may post at most 5 comments per task per minute.",
      inputSchema: {
        key: z.string().describe('Task key, e.g. "ST-12"'),
        body: z.string().min(1).describe("Comment text (Markdown). Never include secrets"),
        parent_id: z.string().optional().describe("Id of the comment you are replying to"),
      },
    },
    ({ key: taskKey, body, parent_id }) =>
      run(async () => {
        const comment = await addComment(db, ctx, taskKey, { body, parentId: parent_id ?? null });
        return commentView(comment, await actorRefs());
      }),
  );

  server.registerTool(
    "get_inbox",
    {
      description:
        "Your notifications: mentions, assignments, comments and replies on your tasks, and changed rules of your projects (kind \"rules\": read them with get_project), oldest first. Pass `after` (the last id you saw) for only newer items, and `wait_seconds` to wait for new ones.",
      inputSchema: {
        unread_only: z.boolean().optional().describe("Only items not marked read (default true)"),
        after: z.number().int().nonnegative().optional().describe("Only items with a larger id"),
        wait_seconds: z.number().int().min(0).max(20).optional().describe("Wait up to this long for new items"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ unread_only, after, wait_seconds, limit }) =>
      run(async () => {
        const query = { unread: unread_only ?? true, after, limit, kinds: [...INBOX_KINDS] };
        const deadline = Date.now() + (wait_seconds ?? 0) * 1000;
        let items = await listInbox(db, ctx, query);
        while (items.length === 0 && Date.now() < deadline) {
          await realtime.waitFor(
            (e) => e.type === "inbox.created" && e.orgId === ctx.orgId && e.recipientIds.includes(ctx.actorId),
            Math.min(5000, deadline - Date.now()),
          );
          items = await listInbox(db, ctx, query);
        }
        return items.map((i) => ({
          id: i.id,
          kind: i.kind,
          ...(i.task ? { task: i.task.key, title: i.task.title } : {}),
          ...(i.document
            ? { project: i.document.projectKey, rulesDocument: { id: i.document.id, title: i.document.title, url: urls.document(i.document.id) } }
            : {}),
          from: i.from.handle,
          comment: i.comment ? { id: i.comment.id, body: i.comment.body } : null,
          createdAt: i.createdAt,
        }));
      }),
  );

  server.registerTool(
    "mark_inbox_read",
    {
      description: "Mark inbox items read, by ids or everything up to an id.",
      inputSchema: {
        ids: z.array(z.number().int().positive()).optional(),
        up_to: z.number().int().positive().optional(),
      },
    },
    ({ ids, up_to }) => run(async () => ({ updated: await markInboxRead(db, ctx, { ids, upTo: up_to }) })),
  );

  server.registerTool(
    "list_tags",
    { description: "List the organization's tags.", inputSchema: {} },
    () => run(async () => (await listTags(db, ctx.orgId)).map((t) => ({ name: t.name, color: t.color }))),
  );

  server.registerTool(
    "create_tag",
    {
      description: "Create an organization-wide tag.",
      inputSchema: {
        name: z.string().min(1).max(40),
        color: z.string().optional().describe("Hex colour like #22c55e"),
      },
    },
    ({ name, color }) => run(async () => createTag(db, ctx, { name, color })),
  );

  server.registerTool(
    "list_members",
    { description: "List the organization's people and agents with their handles.", inputSchema: {} },
    () =>
      run(async () =>
        (await loadMembers()).map((m) => ({ handle: m.handle, name: m.name, type: m.type, role: m.role })),
      ),
  );

  return server;
}

/**
 * Streamable HTTP MCP endpoint, mounted at /mcp. Stateless: every POST gets a fresh server and
 * transport, so there are no session ids and any instance can serve any request.
 * Only agent API keys are accepted; browser sessions are not.
 */
export function mcpRoutes(db: Db, realtime: Realtime, webOrigin: string) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const key = bearer ? await authenticateApiKey(db, bearer.trim()) : null;
    if (!key) {
      c.header("WWW-Authenticate", 'Bearer realm="spider-tracker"');
      const message = bearer ? "Invalid or revoked API key" : "Send an agent API key: Authorization: Bearer spt_…";
      return c.json({ error: { code: "unauthorized", message } }, 401);
    }
    c.set("apiKey", key);
    await next();
  });

  app.post("/", async (c) => {
    const key = c.get("apiKey");
    if (!key) throw new Error("API key middleware didn't run");
    const instructions = (await isInitialize(c.req.raw))
      ? rulesInstructions(key.actor.handle, await listProjectRules(db, { orgId: key.organization.id, actorId: key.actor.id, role: key.actor.role, source: "mcp" }))
      : undefined;
    const server = createMcpServer(db, key, realtime, webOrigin, instructions);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  // Stateless: no server-initiated SSE stream and no sessions to delete.
  app.on(["GET", "DELETE"], "/", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405),
  );

  return app;
}
