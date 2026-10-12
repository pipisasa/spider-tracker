import type { ActivitySource, ActorRole, AgentDto, CreatedAgentInviteDto, ListResponse } from "@repo/core";
import {
  DomainError,
  createAgentInvite,
  eventInScope,
  listAgentInvites,
  revokeAgentInvite,
  scopedProjectKeys,
  addComment,
  createTag,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  updateSavedView,
  deleteTag,
  listTags,
  addRelation,
  listRelations,
  listSubtasks,
  removeRelation,
  listTaskActivity,
  listComments,
  listInbox,
  markInboxRead,
  createAgent,
  deleteAgent,
  updateAgent,
  createApiKey,
  createInvitation,
  listInvitations,
  revokeInvitation,
  archiveProject,
  createProject,
  createTask,
  deleteTask,
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentVersion,
  listDocuments,
  listDocumentVersions,
  moveDocument,
  updateDocument,
  getProject,
  getTask,
  listAgents,
  listMembers,
  listProjects,
  listTasks,
  resolveMembership,
  revokeApiKey,
  updateProject,
  updateTask,
} from "@repo/core";
import type { Db } from "@repo/db";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { toActorDto } from "../dto";
import type { Realtime } from "../realtime";
import type { AppEnv } from "../types";

/** Sources an API-key client may declare with the X-Spider-Source header. */
const clientSources: ActivitySource[] = ["api", "cli", "mcp"];

function clientSource(header: string | undefined): ActivitySource {
  const value = header?.trim().toLowerCase();
  return clientSources.find((s) => s === value) ?? "api";
}

const MAX_INBOX_WAIT_SECONDS = 25;
// A waiting inbox request wakes on "inbox.created" events; this re-check is only a safety net.
const INBOX_RECHECK_MS = 5000;
const SSE_HEARTBEAT_MS = 20_000;

/** Organization-scoped routes, mounted at /v1/orgs/:orgSlug. */
export function orgRoutes(db: Db, realtime: Realtime) {
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

  // GET /members?all=true includes deactivated actors, to name the ones still assigned to tasks.
  app.get("/members", async (c) => {
    const rows = await listMembers(db, c.get("actor").orgId, { includeDeactivated: c.req.query("all") === "true" });
    return c.json(list(rows.map(toActorDto)));
  });

  app.get("/invitations", async (c) => c.json(list(await listInvitations(db, c.get("actor")))));

  app.post("/invitations", async (c) => c.json(await createInvitation(db, c.get("actor"), await body(c)), 201));

  app.delete("/invitations/:invitationId", async (c) => {
    await revokeInvitation(db, c.get("actor"), c.req.param("invitationId"));
    return c.body(null, 204);
  });

  app.get("/agents", async (c) => {
    const rows = await listAgents(db, c.get("actor"));
    return c.json(list<AgentDto>(rows.map((r) => ({ ...r, actor: toActorDto(r.actor) }))));
  });

  // An agent updating itself (name, handle, description).
  app.patch("/agents/me", async (c) => {
    const actor = c.get("actor");
    const updated = await updateAgent(db, actor, actor.actorId, await body(c));
    const agent: AgentDto = { ...updated, actor: toActorDto(updated.actor) };
    return c.json(agent);
  });

  app.patch("/agents/:agentId", async (c) => {
    const updated = await updateAgent(db, c.get("actor"), c.req.param("agentId"), await body(c));
    const agent: AgentDto = { ...updated, actor: toActorDto(updated.actor) };
    return c.json(agent);
  });

  app.delete("/agents/:agentId", async (c) => {
    await deleteAgent(db, c.get("actor"), c.req.param("agentId"));
    return c.body(null, 204);
  });

  app.post("/agents", async (c) => {
    const created = await createAgent(db, c.get("actor"), await body(c));
    const agent: AgentDto = { ...created, actor: toActorDto(created.actor) };
    return c.json(agent, 201);
  });

  app.get("/agent-invites", async (c) => c.json(list(await listAgentInvites(db, c.get("actor")))));

  app.post("/agent-invites", async (c) => {
    const created: CreatedAgentInviteDto = await createAgentInvite(db, c.get("actor"), await body(c));
    return c.json(created, 201);
  });

  app.delete("/agent-invites/:inviteId", async (c) => {
    await revokeAgentInvite(db, c.get("actor"), c.req.param("inviteId"));
    return c.body(null, 204);
  });

  app.post("/agents/:agentId/keys", async (c) =>
    c.json(await createApiKey(db, c.get("actor"), c.req.param("agentId"), await body(c)), 201),
  );

  app.delete("/api-keys/:keyId", async (c) => {
    await revokeApiKey(db, c.get("actor"), c.req.param("keyId"));
    return c.body(null, 204);
  });

  app.get("/tags", async (c) => c.json(list(await listTags(db, c.get("actor").orgId))));

  app.post("/tags", async (c) => c.json(await createTag(db, c.get("actor"), await body(c)), 201));

  app.delete("/tags/:tagId", async (c) => {
    await deleteTag(db, c.get("actor"), c.req.param("tagId"));
    return c.body(null, 204);
  });

  // GET /projects?archived=true includes archived projects.
  app.get("/projects", async (c) =>
    c.json(list(await listProjects(db, c.get("actor"), { includeArchived: c.req.query("archived") === "true" }))),
  );

  app.post("/projects", async (c) => c.json(await createProject(db, c.get("actor"), await body(c)), 201));

  app.get("/projects/:projectKey", async (c) =>
    c.json(await getProject(db, c.get("actor"), c.req.param("projectKey"))),
  );

  app.patch("/projects/:projectKey", async (c) =>
    c.json(await updateProject(db, c.get("actor"), c.req.param("projectKey"), await body(c))),
  );

  app.post("/projects/:projectKey/archive", async (c) =>
    c.json(await archiveProject(db, c.get("actor"), c.req.param("projectKey"), true)),
  );

  app.delete("/projects/:projectKey/archive", async (c) =>
    c.json(await archiveProject(db, c.get("actor"), c.req.param("projectKey"), false)),
  );

  app.get("/projects/:projectKey/tasks", async (c) =>
    c.json(list(await listTasks(db, c.get("actor"), c.req.param("projectKey")))),
  );

  app.post("/projects/:projectKey/tasks", async (c) =>
    c.json(await createTask(db, c.get("actor"), c.req.param("projectKey"), await body(c)), 201),
  );

  app.get("/projects/:projectKey/views", async (c) =>
    c.json(list(await listSavedViews(db, c.get("actor"), c.req.param("projectKey")))),
  );

  app.post("/projects/:projectKey/views", async (c) =>
    c.json(await createSavedView(db, c.get("actor"), c.req.param("projectKey"), await body(c)), 201),
  );

  app.patch("/projects/:projectKey/views/:viewId", async (c) =>
    c.json(await updateSavedView(db, c.get("actor"), c.req.param("projectKey"), c.req.param("viewId"), await body(c))),
  );

  app.delete("/projects/:projectKey/views/:viewId", async (c) => {
    await deleteSavedView(db, c.get("actor"), c.req.param("projectKey"), c.req.param("viewId"));
    return c.body(null, 204);
  });

  app.get("/tasks/:taskKey", async (c) => c.json(await getTask(db, c.get("actor"), c.req.param("taskKey"))));

  app.patch("/tasks/:taskKey", async (c) =>
    c.json(await updateTask(db, c.get("actor"), c.req.param("taskKey"), await body(c))),
  );

  app.get("/tasks/:taskKey/subtasks", async (c) =>
    c.json(list(await listSubtasks(db, c.get("actor"), c.req.param("taskKey")))),
  );

  app.get("/tasks/:taskKey/relations", async (c) =>
    c.json(list(await listRelations(db, c.get("actor"), c.req.param("taskKey")))),
  );

  app.post("/tasks/:taskKey/relations", async (c) =>
    c.json(await addRelation(db, c.get("actor"), c.req.param("taskKey"), await body(c)), 201),
  );

  // DELETE /tasks/ST-1/relations?kind=blocks&task=ST-2
  app.delete("/tasks/:taskKey/relations", async (c) => {
    await removeRelation(db, c.get("actor"), c.req.param("taskKey"), c.req.query());
    return c.body(null, 204);
  });

  app.get("/tasks/:taskKey/activity", async (c) =>
    c.json(list(await listTaskActivity(db, c.get("actor"), c.req.param("taskKey")))),
  );

  app.get("/tasks/:taskKey/comments", async (c) =>
    c.json(list(await listComments(db, c.get("actor"), c.req.param("taskKey")))),
  );

  app.post("/tasks/:taskKey/comments", async (c) =>
    c.json(await addComment(db, c.get("actor"), c.req.param("taskKey"), await body(c)), 201),
  );

  // GET /documents?project=ST or ?task=ST-12; without either, the whole organization's.
  app.get("/documents", async (c) => c.json(list(await listDocuments(db, c.get("actor"), c.req.query()))));

  app.post("/documents", async (c) => c.json(await createDocument(db, c.get("actor"), await body(c)), 201));

  app.get("/documents/:documentId", async (c) =>
    c.json(await getDocument(db, c.get("actor"), c.req.param("documentId"))),
  );

  app.patch("/documents/:documentId", async (c) =>
    c.json(await updateDocument(db, c.get("actor"), c.req.param("documentId"), await body(c))),
  );

  // POST { project: "KEY" | null }: move to a project, or make the document organization-wide.
  app.post("/documents/:documentId/move", async (c) =>
    c.json(await moveDocument(db, c.get("actor"), c.req.param("documentId"), await body(c))),
  );

  app.delete("/documents/:documentId", async (c) => {
    await deleteDocument(db, c.get("actor"), c.req.param("documentId"));
    return c.body(null, 204);
  });

  app.get("/documents/:documentId/versions", async (c) =>
    c.json(list(await listDocumentVersions(db, c.get("actor"), c.req.param("documentId")))),
  );

  app.get("/documents/:documentId/versions/:version", async (c) =>
    c.json(await getDocumentVersion(db, c.get("actor"), c.req.param("documentId"), c.req.param("version"))),
  );

  // The caller's inbox. With ?wait=N (seconds, max 25) it holds the request until an item
  // newer than ?after arrives, so agents and the Claude Code channel can wait cheaply.
  app.get("/inbox", async (c) => {
    const query = c.req.query();
    const wait = Math.min(Math.max(Number(query.wait) || 0, 0), MAX_INBOX_WAIT_SECONDS);
    const deadline = Date.now() + wait * 1000;
    const signal = c.req.raw.signal;
    const actor = c.get("actor");
    let items = await listInbox(db, actor, query);
    while (items.length === 0 && Date.now() < deadline && !signal.aborted) {
      await realtime.waitFor(
        (e) => e.type === "inbox.created" && e.orgId === actor.orgId && e.recipientIds.includes(actor.actorId),
        Math.min(INBOX_RECHECK_MS, deadline - Date.now()),
        signal,
      );
      items = await listInbox(db, actor, query);
    }
    return c.json(list(items));
  });

  // Server-sent change events for the organization: the web app refreshes what changed.
  // Event payloads carry keys and ids only; clients refetch through the normal routes.
  // Agents limited to some projects only hear about those (and organization-wide changes).
  app.get("/events", async (c) => {
    const actor = c.get("actor");
    const { orgId } = actor;
    const keys = await scopedProjectKeys(db, actor);
    return streamSSE(c, async (stream) => {
      const unsubscribe = await realtime.subscribe((event) => {
        if (event.orgId !== orgId || !eventInScope(event, keys)) return;
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(SSE_HEARTBEAT_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
      unsubscribe();
    });
  });

  app.post("/inbox/read", async (c) => c.json({ updated: await markInboxRead(db, c.get("actor"), await body(c)) }));

  app.delete("/tasks/:taskKey", async (c) => {
    await deleteTask(db, c.get("actor"), c.req.param("taskKey"));
    return c.body(null, 204);
  });

  return app;
}
