import type { ActivitySource, ActorRole, AgentDto, ListResponse } from "@repo/core";
import {
  DomainError,
  createAgent,
  createApiKey,
  createProject,
  createTask,
  deleteTask,
  getProject,
  getTask,
  listAgents,
  listMembers,
  listProjects,
  listTasks,
  resolveMembership,
  revokeApiKey,
  updateTask,
} from "@repo/core";
import type { Db } from "@repo/db";
import { Hono } from "hono";
import { toActorDto } from "../dto";
import type { AppEnv } from "../types";

/** Sources an API-key client may declare with the X-Spider-Source header. */
const clientSources: ActivitySource[] = ["api", "cli", "mcp"];

function clientSource(header: string | undefined): ActivitySource {
  const value = header?.trim().toLowerCase();
  return clientSources.find((s) => s === value) ?? "api";
}

/** Organization-scoped routes, mounted at /v1/orgs/:orgSlug. */
export function orgRoutes(db: Db) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const slug = c.req.param("orgSlug") ?? "";
    const key = c.get("apiKey");
    const user = c.get("user");
    let membership: { organization: { id: string; slug: string }; actor: { id: string; role: ActorRole } };
    if (key) {
      // A key acts only inside its agent's organization.
      if (key.organization.slug !== slug) throw new DomainError("not_found", "Organization not found");
      membership = key;
    } else if (user) {
      membership = await resolveMembership(db, user.id, slug);
    } else {
      throw new DomainError("forbidden", "Not signed in");
    }
    c.set("actor", {
      orgId: membership.organization.id,
      actorId: membership.actor.id,
      role: membership.actor.role,
      // Browser sessions are always "ui"; key clients (CLI, MCP) may say what they are.
      source: key ? clientSource(c.req.header("X-Spider-Source")) : "ui",
    });
    await next();
  });

  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  const list = <T>(items: T[]): ListResponse<T> => ({ items });

  app.get("/members", async (c) => {
    const rows = await listMembers(db, c.get("actor").orgId);
    return c.json(list(rows.map(toActorDto)));
  });

  app.get("/agents", async (c) => {
    const rows = await listAgents(db, c.get("actor").orgId);
    return c.json(list<AgentDto>(rows.map((r) => ({ ...r, actor: toActorDto(r.actor) }))));
  });

  app.post("/agents", async (c) => {
    const created = await createAgent(db, c.get("actor"), await body(c));
    const agent: AgentDto = { ...created, actor: toActorDto(created.actor) };
    return c.json(agent, 201);
  });

  app.post("/agents/:agentId/keys", async (c) =>
    c.json(await createApiKey(db, c.get("actor"), c.req.param("agentId"), await body(c)), 201),
  );

  app.delete("/api-keys/:keyId", async (c) => {
    await revokeApiKey(db, c.get("actor"), c.req.param("keyId"));
    return c.body(null, 204);
  });

  app.get("/projects", async (c) => c.json(list(await listProjects(db, c.get("actor").orgId))));

  app.post("/projects", async (c) => c.json(await createProject(db, c.get("actor"), await body(c)), 201));

  app.get("/projects/:projectKey", async (c) =>
    c.json(await getProject(db, c.get("actor").orgId, c.req.param("projectKey"))),
  );

  app.get("/projects/:projectKey/tasks", async (c) =>
    c.json(list(await listTasks(db, c.get("actor").orgId, c.req.param("projectKey")))),
  );

  app.post("/projects/:projectKey/tasks", async (c) =>
    c.json(await createTask(db, c.get("actor"), c.req.param("projectKey"), await body(c)), 201),
  );

  app.get("/tasks/:taskKey", async (c) => c.json(await getTask(db, c.get("actor").orgId, c.req.param("taskKey"))));

  app.patch("/tasks/:taskKey", async (c) =>
    c.json(await updateTask(db, c.get("actor"), c.req.param("taskKey"), await body(c))),
  );

  app.delete("/tasks/:taskKey", async (c) => {
    await deleteTask(db, c.get("actor"), c.req.param("taskKey"));
    return c.body(null, 204);
  });

  return app;
}
