import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActorContext, DocumentSummaryDto, ProjectDetailDto, StatusDto, TaskDto } from "@repo/core";
import { matchStatuses } from "@repo/core/statuses";
import {
  DomainError,
  addComment,
  authenticateApiKey,
  createDocument,
  getDocument,
  getDocumentVersion,
  listDocuments,
  updateDocument,
  createTask,
  getProject,
  getTask,
  listMembers,
  listProjects,
  createTag,
  listComments,
  addRelation,
  listRelations,
  listSubtasks,
  removeRelation,
  listTags,
  listTaskActivity,
  listInbox,
  listTasks,
  markInboxRead,
  updateTask,
} from "@repo/core";
import type { Db, schema } from "@repo/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Realtime } from "./realtime";
import type { AppEnv } from "./types";

type ActorRow = typeof schema.actors.$inferSelect;
type Key = NonNullable<AppEnv["Variables"]["apiKey"]>;

const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"];

const priority = z
  .number()
  .int()
  .min(0)
  .max(4)
  .describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");
const tagsInput = z.array(z.string()).max(20).describe("Tag names (see list_tags)");
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

/** Tracker tools for one request, acting as the key's agent inside its organization. */
function createMcpServer(db: Db, key: Key, realtime: Realtime) {
  const ctx: ActorContext = {
    orgId: key.organization.id,
    actorId: key.actor.id,
    role: key.actor.role,
    source: "mcp",
  };

  let members: Promise<ActorRow[]> | undefined;
  const loadMembers = () => (members ??= listMembers(db, ctx.orgId));

  const handleOf = async (actorId: string) => (await loadMembers()).find((m) => m.id === actorId)?.handle ?? actorId;

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

  const resolveStatus = (project: ProjectDetailDto, name: string): StatusDto => {
    // A category ("in_progress") picks its first status in board order, like the CLI.
    const status = matchStatuses(project, name)[0];
    if (!status) {
      throw new DomainError(
        "validation",
        `Unknown status "${name}" in ${project.key}. Valid statuses: ${project.statuses.map((s) => s.name).join(", ")}`,
      );
    }
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
  const tagNames = async (ids: string[]) => {
    const rows = await listTags(db, ctx.orgId);
    return ids.map((id) => rows.find((t) => t.id === id)?.name ?? id);
  };

  const projectOfTask = (taskKey: string) => getProject(db, ctx.orgId, taskKey.split("-")[0] ?? "");

  /** A task as the model sees it: names and handles instead of ids. */
  const describeTask = async (task: TaskDto, project: ProjectDetailDto, detail = false) => ({
    key: task.key,
    title: task.title,
    status: project.statuses.find((s) => s.id === task.statusId)?.name ?? task.statusId,
    priority: PRIORITY_NAMES[task.priority],
    assignees: await Promise.all(task.assigneeIds.map(handleOf)),
    tags: await tagNames(task.tagIds),
    parent: task.parentKey,
    ...(detail
      ? {
          description: task.description,
          creator: await handleOf(task.creatorId),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
        }
      : {}),
  });

  const server = new McpServer({ name: "spider-tracker", version: "0.1.0" });

  server.registerTool(
    "whoami",
    { description: "Show which agent you are and which organization you act in.", inputSchema: {} },
    () =>
      run(async () => ({
        organization: { slug: key.organization.slug, name: key.organization.name },
        you: { handle: key.actor.handle, name: key.actor.name, role: key.actor.role },
      })),
  );

  server.registerTool(
    "list_projects",
    { description: "List the organization's projects (key, name, description).", inputSchema: {} },
    () =>
      run(async () =>
        (await listProjects(db, ctx.orgId)).map((p) => ({ key: p.key, name: p.name, description: p.description })),
      ),
  );

  server.registerTool(
    "get_project",
    {
      description:
        "Get a project, its workflow statuses (in board order, with their categories) and its documents (read them with get_document).",
      inputSchema: { projectKey: z.string().describe('Project key, e.g. "ST"') },
    },
    ({ projectKey }) =>
      run(async () => {
        const project = await getProject(db, ctx.orgId, projectKey);
        const documents = await listDocuments(db, ctx.orgId, { project: project.key });
        return {
          key: project.key,
          name: project.name,
          description: project.description,
          statuses: project.statuses.map((s) => ({ name: s.name, category: s.category })),
          documents: documents.map((d) => ({ id: d.id, title: d.title, task: d.taskKey })),
        };
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks in a project, in board order. Filter by status (a status name or a category such as todo, in_progress, done), assignee and title text.",
      inputSchema: {
        projectKey: z.string().describe('Project key, e.g. "ST"'),
        status: z.string().optional().describe('Status name ("In Progress") or category ("in_progress")'),
        assignee: z.string().optional().describe('"me" or a member handle'),
        query: z.string().optional().describe("Case-insensitive text to find in titles"),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum tasks to return (default 50)"),
      },
    },
    ({ projectKey, status, assignee, query, limit }) =>
      run(async () => {
        const project = await getProject(db, ctx.orgId, projectKey);
        let tasks = await listTasks(db, ctx.orgId, project.key);
        if (status) {
          const wanted = status.trim().toLowerCase();
          const ids = project.statuses
            .filter((s) => s.name.toLowerCase() === wanted || s.category === wanted)
            .map((s) => s.id);
          if (ids.length === 0) resolveStatus(project, status);
          tasks = tasks.filter((t) => ids.includes(t.statusId));
        }
        if (assignee) {
          const [actorId] = await resolveAssignees([assignee]);
          tasks = tasks.filter((t) => actorId && t.assigneeIds.includes(actorId));
        }
        if (query) {
          const needle = query.toLowerCase();
          tasks = tasks.filter((t) => t.title.toLowerCase().includes(needle));
        }
        const shown = tasks.slice(0, limit ?? 50);
        return {
          total: tasks.length,
          tasks: await Promise.all(shown.map((t) => describeTask(t, project))),
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
        const task = await getTask(db, ctx.orgId, taskKey);
        const [subtasks, relations, documents] = await Promise.all([
          listSubtasks(db, ctx.orgId, task.key),
          listRelations(db, ctx.orgId, task.key),
          listDocuments(db, ctx.orgId, { task: task.key }),
        ]);
        return {
          relations: relations.map((r) => ({ kind: r.kind, task: r.task.key, title: r.task.title })),
          documents: documents.map((d) => ({ id: d.id, title: d.title })),
          ...(await describeTask(task, await projectOfTask(task.key), true)),
          subtasks: await Promise.all(
            subtasks.map(async (t) => {
              const { key, title, status } = await describeTask(t, await projectOfTask(t.key));
              return { key, title, status };
            }),
          ),
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
      },
    },
    ({ projectKey, title, description, status, priority, assignees, tags, parent }) =>
      run(async () => {
        const project = await getProject(db, ctx.orgId, projectKey);
        const task = await createTask(db, ctx, project.key, {
          title,
          description,
          priority,
          statusId: status ? resolveStatus(project, status).id : undefined,
          assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
          tagIds: tags ? await resolveTags(tags) : undefined,
          parentId: parent ? (await getTask(db, ctx.orgId, parent)).id : undefined,
        });
        return describeTask(task, project, true);
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
        status: z.string().optional().describe("Status name; see get_project"),
        priority: priority.optional(),
        assignees: assigneesInput.optional(),
        tags: tagsInput.optional(),
        parent: z.string().nullable().optional().describe('Parent task key; null makes it a top-level task'),
      },
    },
    ({ key: taskKey, title, description, status, priority, assignees, tags, parent }) =>
      run(async () => {
        const project = await projectOfTask(taskKey);
        const task = await updateTask(db, ctx, taskKey, {
          title,
          description,
          priority,
          statusId: status ? resolveStatus(project, status).id : undefined,
          assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
          tagIds: tags ? await resolveTags(tags) : undefined,
          parentId: parent === undefined ? undefined : parent === null ? null : (await getTask(db, ctx.orgId, parent)).id,
        });
        return describeTask(task, project, true);
      }),
  );

  /** Adds you to a task's assignees and optionally moves it. */
  const takeTask = async (taskKey: string, moveToInProgress: boolean) => {
    const project = await projectOfTask(taskKey);
    const current = await getTask(db, ctx.orgId, taskKey);
    let statusId: string | undefined;
    if (moveToInProgress) {
      const status = project.statuses.find((s) => s.category === "in_progress");
      if (!status) throw new DomainError("validation", `${project.key} has no in-progress status`);
      statusId = status.id;
    }
    const assigneeIds = current.assigneeIds.includes(ctx.actorId)
      ? current.assigneeIds
      : [...current.assigneeIds, ctx.actorId];
    const task = await updateTask(db, ctx, current.key, { assigneeIds, statusId });
    return describeTask(task, project, true);
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
      description: "Start working on a task: assign it to yourself and move it to the project's first in-progress status.",
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

  /** A document as the model sees it: scope keys and the author's handle. */
  const describeDocument = async (d: DocumentSummaryDto) => ({
    id: d.id,
    title: d.title,
    format: d.format,
    project: d.projectKey,
    task: d.taskKey,
    version: d.version,
    updatedBy: await handleOf(d.authorId),
    updatedAt: d.updatedAt,
  });

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
      run(async () => Promise.all((await listDocuments(db, ctx.orgId, { project, task })).map(describeDocument))),
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
        const document = await getDocument(db, ctx.orgId, id);
        if (version === undefined || version === document.version) {
          return { ...(await describeDocument(document)), content: document.content };
        }
        const old = await getDocumentVersion(db, ctx.orgId, id, version);
        return {
          id: document.id,
          title: old.title,
          format: old.format,
          version: old.version,
          currentVersion: document.version,
          savedBy: old.authorId ? await handleOf(old.authorId) : null,
          savedAt: old.createdAt,
          content: old.content,
        };
      }),
  );

  server.registerTool(
    "create_document",
    {
      description:
        "Create a document: organization-wide, in a project, or on a task (the task's project is implied). Markdown by default.",
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
    "update_document",
    {
      description:
        "Save a new version of a document. Only the fields you pass change; content replaces the whole text. Fails if someone saved since baseVersion: read it again with get_document and reapply your edit.",
      inputSchema: {
        id: z.string().describe("Document id"),
        baseVersion: z.number().int().positive().describe("The version you read (from get_document)"),
        title: z.string().optional(),
        content: z.string().optional().describe("The full new content"),
        format: z.enum(["md", "html"]).optional(),
      },
    },
    ({ id, baseVersion, title, content, format }) =>
      run(async () => describeDocument(await updateDocument(db, ctx, id, { baseVersion, title, content, format }))),
  );

  server.registerTool(
    "list_comments",
    {
      description: "Read the comments under a task, oldest first, with author handles.",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) =>
      run(async () =>
        Promise.all(
          (await listComments(db, ctx.orgId, taskKey)).map(async (c) => ({
            id: c.id,
            author: await handleOf(c.authorId),
            body: c.body,
            parentId: c.parentId,
            createdAt: c.createdAt,
          })),
        ),
      ),
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
        const statusName = (id: unknown) => project.statuses.find((s) => s.id === id)?.name ?? id;
        const handles = async (ids: unknown) => (Array.isArray(ids) ? Promise.all(ids.map((id) => handleOf(String(id)))) : ids);
        return Promise.all(
          (await listTaskActivity(db, ctx.orgId, taskKey)).map(async (e) => {
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
        "Comment on a task (Markdown). Mention people or agents with @handle to notify them; set parent_id to reply to a comment. Agents are rate-limited and must wait for a person after a long agent-only thread.",
      inputSchema: {
        key: z.string().describe('Task key, e.g. "ST-12"'),
        body: z.string().min(1).describe("Comment text (Markdown). Never include secrets"),
        parent_id: z.string().optional().describe("Id of the comment you are replying to"),
      },
    },
    ({ key: taskKey, body, parent_id }) =>
      run(async () => {
        const comment = await addComment(db, ctx, taskKey, { body, parentId: parent_id ?? null });
        return { id: comment.id, task: comment.taskKey, createdAt: comment.createdAt };
      }),
  );

  server.registerTool(
    "get_inbox",
    {
      description:
        "Your notifications: mentions, assignments, comments and replies on your tasks, oldest first. Pass `after` (the last id you saw) for only newer items, and `wait_seconds` to wait for new ones.",
      inputSchema: {
        unread_only: z.boolean().optional().describe("Only items not marked read (default true)"),
        after: z.number().int().nonnegative().optional().describe("Only items with a larger id"),
        wait_seconds: z.number().int().min(0).max(20).optional().describe("Wait up to this long for new items"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ unread_only, after, wait_seconds, limit }) =>
      run(async () => {
        const query = { unread: unread_only ?? true, after, limit };
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
          task: i.task.key,
          title: i.task.title,
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
export function mcpRoutes(db: Db, realtime: Realtime) {
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
    const server = createMcpServer(db, key, realtime);
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
