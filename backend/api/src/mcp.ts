import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActorContext, ProjectDetailDto, StatusDto, TaskDto } from "@repo/core";
import { matchStatuses } from "@repo/core/statuses";
import {
  DomainError,
  authenticateApiKey,
  createTask,
  getProject,
  getTask,
  listMembers,
  listProjects,
  listTasks,
  updateTask,
} from "@repo/core";
import type { Db, schema } from "@repo/db";
import { Hono } from "hono";
import { z } from "zod";
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
function createMcpServer(db: Db, key: Key) {
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

  const projectOfTask = (taskKey: string) => getProject(db, ctx.orgId, taskKey.split("-")[0] ?? "");

  /** A task as the model sees it: names and handles instead of ids. */
  const describeTask = async (task: TaskDto, project: ProjectDetailDto, detail = false) => ({
    key: task.key,
    title: task.title,
    status: project.statuses.find((s) => s.id === task.statusId)?.name ?? task.statusId,
    priority: PRIORITY_NAMES[task.priority],
    assignees: await Promise.all(task.assigneeIds.map(handleOf)),
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
      description: "Get a project and its workflow statuses, in board order, with their categories.",
      inputSchema: { projectKey: z.string().describe('Project key, e.g. "ST"') },
    },
    ({ projectKey }) =>
      run(async () => {
        const project = await getProject(db, ctx.orgId, projectKey);
        return {
          key: project.key,
          name: project.name,
          description: project.description,
          statuses: project.statuses.map((s) => ({ name: s.name, category: s.category })),
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
      description: "Get a task by key, with its description, status name and assignee handles.",
      inputSchema: { key: z.string().describe('Task key, e.g. "ST-12"') },
    },
    ({ key: taskKey }) =>
      run(async () => {
        const task = await getTask(db, ctx.orgId, taskKey);
        return describeTask(task, await projectOfTask(task.key), true);
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
      },
    },
    ({ projectKey, title, description, status, priority, assignees }) =>
      run(async () => {
        const project = await getProject(db, ctx.orgId, projectKey);
        const task = await createTask(db, ctx, project.key, {
          title,
          description,
          priority,
          statusId: status ? resolveStatus(project, status).id : undefined,
          assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
        });
        return describeTask(task, project, true);
      }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Update a task. Only the fields you pass change; assignees replaces the whole list.",
      inputSchema: {
        key: z.string().describe('Task key, e.g. "ST-12"'),
        title: z.string().optional(),
        description: z.string().nullable().optional().describe("Markdown; null clears it"),
        status: z.string().optional().describe("Status name; see get_project"),
        priority: priority.optional(),
        assignees: assigneesInput.optional(),
      },
    },
    ({ key: taskKey, title, description, status, priority, assignees }) =>
      run(async () => {
        const project = await projectOfTask(taskKey);
        const task = await updateTask(db, ctx, taskKey, {
          title,
          description,
          priority,
          statusId: status ? resolveStatus(project, status).id : undefined,
          assigneeIds: assignees ? await resolveAssignees(assignees) : undefined,
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
export function mcpRoutes(db: Db) {
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
    const server = createMcpServer(db, key);
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
