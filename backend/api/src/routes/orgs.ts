import type { ListResponse } from "@repo/core";
import {
  createProject,
  createTask,
  deleteTask,
  getProject,
  getTask,
  listMembers,
  listProjects,
  listTasks,
  resolveMembership,
  updateTask,
} from "@repo/core";
import type { Db } from "@repo/db";
import { Hono } from "hono";
import { toActorDto } from "../dto";
import type { AppEnv } from "../types";

/** Organization-scoped routes, mounted at /v1/orgs/:orgSlug. */
export function orgRoutes(db: Db) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const { organization, actor } = await resolveMembership(db, c.get("user").id, c.req.param("orgSlug") ?? "");
    c.set("actor", { orgId: organization.id, actorId: actor.id, role: actor.role, source: "api" });
    await next();
  });

  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  const list = <T>(items: T[]): ListResponse<T> => ({ items });

  app.get("/members", async (c) => {
    const rows = await listMembers(db, c.get("actor").orgId);
    return c.json(list(rows.map(toActorDto)));
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
