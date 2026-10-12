import type { ActivitySource, ActorRole, AgentDto, CreatedAgentInviteDto, ListResponse } from "@repo/core";
import {
  DomainError,
  createAgentInvite,
  eventInScope,
  listAgentInvites,
  revokeAgentInvite,
  scopedProjectKeys,
  addComment,
  addDocumentComment,
  listDocumentComments,
  resolveDocumentComment,
  createTag,
  attachRepo,
  createApp,
  createRepo,
  deleteApp,
  deleteRepo,
  detachRepo,
  getRepo,
  listRepos,
  updateApp,
  updateRepo,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  updateSavedView,
  deleteTag,
  listTags,
  addRelation,
  markDuplicate,
  listRelations,
  listSubtasks,
  removeRelation,
  listTaskActivity,
  getTaskGit,
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
  createStatus,
  updateStatus,
  deleteStatus,
  createDocument,
  deleteDocument,
  editDocument,
  getDocument,
  getDocumentGraph,
  diffDocumentVersions,
  getDocumentVersion,
  listBacklinks,
  listTaskBacklinks,
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
  activeAgentsInProject,
  PRESENCE_WINDOW_MS,
  resolveMembership,
  revokeApiKey,
  updateProject,
  updateTask,
  updateTasks,
  addToRelease,
  createRelease,
  getRelease,
  listReleaseCandidates,
  listReleases,
  removeFromRelease,
  updateRelease,
  getReleaseChangelog,
  writeReleaseChangelog,
  type ReleaseDto,
  webUrls,
  withChangelogUrls,
  withDocumentUrl,
  withProjectUrl,
  withTaskUrl,
} from "@repo/core";
import type { Db } from "@repo/db";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { toActorDto } from "../dto";
import type { GithubApp } from "../github";
import { githubOrgRoutes } from "./github";
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

/**
 * Organization-scoped routes, mounted at /v1/orgs/:orgSlug; `webOrigin` builds the `url` fields.
 * `github` is the GitHub App (null when not configured) and the secret that signs its install state.
 */
export function orgRoutes(
  db: Db,
  realtime: Realtime,
  webOrigin: string,
  github: { app: GithubApp | null; stateSecret: string },
) {
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
    c.set("urls", webUrls(webOrigin, membership.organization.slug));
    await next();
  });

  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  const list = <T>(items: T[]): ListResponse<T> => ({ items });
  // Projects, tasks and documents carry their web page's address (ST-115).
  type C = Context<AppEnv>;
  const project = <T extends { key: string }>(c: C, p: T) => withProjectUrl(c.get("urls"), p);
  const task = <T extends { key: string }>(c: C, t: T) => withTaskUrl(c.get("urls"), t);
  const document = <T extends { id: string }>(c: C, d: T) => withDocumentUrl(c.get("urls"), d);
  /** A release and its included tasks carry their web pages (ST-93). */
  const release = (c: C, r: ReleaseDto) => ({ ...task(c, r), tasks: r.tasks.map((t) => task(c, t)) });

  // GET /members?all=true includes deactivated actors, to name the ones still assigned to tasks.
  app.get("/members", async (c) => {
    const rows = await listMembers(db, c.get("actor").orgId, { includeDeactivated: c.req.query("all") === "true" });
    return c.json(list(rows.map((r) => toActorDto(r, r.ownerId))));
  });

  app.get("/invitations", async (c) => c.json(list(await listInvitations(db, c.get("actor")))));

  app.post("/invitations", async (c) => c.json(await createInvitation(db, c.get("actor"), await body(c)), 201));

  app.delete("/invitations/:invitationId", async (c) => {
    await revokeInvitation(db, c.get("actor"), c.req.param("invitationId"));
    return c.body(null, 204);
  });

  app.get("/agents", async (c) => {
    const rows = await listAgents(db, c.get("actor"));
    return c.json(list<AgentDto>(rows.map((r) => ({ ...r, actor: toActorDto(r.actor, r.ownerId) }))));
  });

  // An agent updating itself (name, handle, description).
  app.patch("/agents/me", async (c) => {
    const actor = c.get("actor");
    const updated = await updateAgent(db, actor, actor.actorId, await body(c));
    const agent: AgentDto = { ...updated, actor: toActorDto(updated.actor, updated.ownerId) };
    return c.json(agent);
  });

  app.patch("/agents/:agentId", async (c) => {
    const updated = await updateAgent(db, c.get("actor"), c.req.param("agentId"), await body(c));
    const agent: AgentDto = { ...updated, actor: toActorDto(updated.actor, updated.ownerId) };
    return c.json(agent);
  });

  app.delete("/agents/:agentId", async (c) => {
    await deleteAgent(db, c.get("actor"), c.req.param("agentId"));
    return c.body(null, 204);
  });

  app.post("/agents", async (c) => {
    const created = await createAgent(db, c.get("actor"), await body(c));
    const agent: AgentDto = { ...created, actor: toActorDto(created.actor, created.ownerId) };
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

  // The GitHub App (ST-82): Settings → GitHub.
  app.route("/github", githubOrgRoutes(db, github.app, github.stateSecret));

  // Repos and their apps (ST-92); a repo is addressed as /repos/:owner/:name.
  const repoRef = (c: C) => `${c.req.param("owner")}/${c.req.param("name")}`;

  // GET /repos?project=ST: only the repos attached to ST.
  app.get("/repos", async (c) => c.json(list(await listRepos(db, c.get("actor"), { project: c.req.query("project") }))));

  app.post("/repos", async (c) => c.json(await createRepo(db, c.get("actor"), await body(c)), 201));

  app.get("/repos/:owner/:name", async (c) => c.json(await getRepo(db, c.get("actor"), repoRef(c))));

  app.patch("/repos/:owner/:name", async (c) => c.json(await updateRepo(db, c.get("actor"), repoRef(c), await body(c))));

  app.delete("/repos/:owner/:name", async (c) => {
    await deleteRepo(db, c.get("actor"), repoRef(c));
    return c.body(null, 204);
  });

  app.post("/repos/:owner/:name/apps", async (c) => c.json(await createApp(db, c.get("actor"), repoRef(c), await body(c)), 201));

  app.patch("/repos/:owner/:name/apps/:app", async (c) =>
    c.json(await updateApp(db, c.get("actor"), repoRef(c), c.req.param("app"), await body(c))),
  );

  app.delete("/repos/:owner/:name/apps/:app", async (c) => {
    await deleteApp(db, c.get("actor"), repoRef(c), c.req.param("app"));
    return c.body(null, 204);
  });

  // POST { repo: "owner/name" }: attach a repo to the project; again changes nothing.
  app.post("/projects/:projectKey/repos", async (c) =>
    c.json(await attachRepo(db, c.get("actor"), c.req.param("projectKey"), await body(c))),
  );

  app.delete("/projects/:projectKey/repos/:owner/:name", async (c) =>
    c.json(await detachRepo(db, c.get("actor"), c.req.param("projectKey"), repoRef(c))),
  );

  // GET /projects?archived=true includes archived projects.
  app.get("/projects", async (c) =>
    c.json(
      list(
        (await listProjects(db, c.get("actor"), { includeArchived: c.req.query("archived") === "true" })).map((p) =>
          project(c, p),
        ),
      ),
    ),
  );

  app.post("/projects", async (c) => c.json(project(c, await createProject(db, c.get("actor"), await body(c))), 201));

  app.get("/projects/:projectKey", async (c) =>
    c.json(project(c, await getProject(db, c.get("actor"), c.req.param("projectKey")))),
  );

  app.patch("/projects/:projectKey", async (c) =>
    c.json(project(c, await updateProject(db, c.get("actor"), c.req.param("projectKey"), await body(c)))),
  );

  app.post("/projects/:projectKey/archive", async (c) =>
    c.json(project(c, await archiveProject(db, c.get("actor"), c.req.param("projectKey"), true))),
  );

  app.delete("/projects/:projectKey/archive", async (c) =>
    c.json(project(c, await archiveProject(db, c.get("actor"), c.req.param("projectKey"), false))),
  );

  // Workflow editing (ST-90): each answers with the project and all its workflows.
  app.post("/projects/:projectKey/statuses", async (c) =>
    c.json(project(c, await createStatus(db, c.get("actor"), c.req.param("projectKey"), await body(c))), 201),
  );

  app.patch("/projects/:projectKey/statuses/:statusId", async (c) =>
    c.json(project(c, await updateStatus(db, c.get("actor"), c.req.param("projectKey"), c.req.param("statusId"), await body(c)))),
  );

  // DELETE …/statuses/<id>?moveTo=<status id>: its tasks move there first.
  app.delete("/projects/:projectKey/statuses/:statusId", async (c) => {
    const result = await deleteStatus(db, c.get("actor"), c.req.param("projectKey"), c.req.param("statusId"), {
      moveTo: c.req.query("moveTo"),
    });
    return c.json({ ...result, project: project(c, result.project) });
  });

  // ?status=&assignee=&tag=&priority= repeat for several values, ?tagMatch=any, ?overdue=true, ?kind=; see taskListFilters.
  app.get("/projects/:projectKey/tasks", async (c) => {
    const query = c.req.queries();
    const filters = {
      kind: c.req.query("kind"),
      status: query.status,
      assignee: query.assignee,
      tags: query.tag,
      tagMatch: c.req.query("tagMatch"),
      priority: query.priority,
      q: c.req.query("q"),
      parent: c.req.query("parent"),
      overdue: c.req.query("overdue"),
    };
    return c.json(list((await listTasks(db, c.get("actor"), c.req.param("projectKey"), filters)).map((t) => task(c, t))));
  });

  app.post("/projects/:projectKey/tasks", async (c) =>
    c.json(task(c, await createTask(db, c.get("actor"), c.req.param("projectKey"), await body(c))), 201),
  );

  // Releases (ST-93): tasks of kind release with repos, apps and included Done tasks. ?status= repeats, ?app=web.
  app.get("/projects/:projectKey/releases", async (c) =>
    c.json(
      list(
        (await listReleases(db, c.get("actor"), c.req.param("projectKey"), { status: c.req.queries().status, app: c.req.query("app") })).map((r) =>
          release(c, r),
        ),
      ),
    ),
  );

  app.post("/projects/:projectKey/releases", async (c) =>
    c.json(release(c, await createRelease(db, c.get("actor"), c.req.param("projectKey"), await body(c))), 201),
  );

  app.get("/releases/:taskKey", async (c) => c.json(release(c, await getRelease(db, c.get("actor"), c.req.param("taskKey")))));

  app.patch("/releases/:taskKey", async (c) =>
    c.json(release(c, await updateRelease(db, c.get("actor"), c.req.param("taskKey"), await body(c)))),
  );

  app.post("/releases/:taskKey/tasks", async (c) =>
    c.json(release(c, await addToRelease(db, c.get("actor"), c.req.param("taskKey"), await body(c)))),
  );

  app.delete("/releases/:taskKey/tasks/:includedKey", async (c) =>
    c.json(release(c, await removeFromRelease(db, c.get("actor"), c.req.param("taskKey"), { tasks: [c.req.param("includedKey")] }))),
  );

  // Changelog (ST-95): generated from the included tasks' handoff notes; POST writes it into the
  // release's description ({ taskApps?, force? }), never overwriting a hand-edited block unless forced.
  app.get("/releases/:taskKey/changelog", async (c) =>
    c.json(withChangelogUrls(c.get("urls"), await getReleaseChangelog(db, c.get("actor"), c.req.param("taskKey")))),
  );

  app.post("/releases/:taskKey/changelog", async (c) =>
    c.json(withChangelogUrls(c.get("urls"), await writeReleaseChangelog(db, c.get("actor"), c.req.param("taskKey"), (await body(c)) ?? {}))),
  );

  app.get("/release-candidates", async (c) =>
    c.json(
      list(
        (await listReleaseCandidates(db, c.get("actor"), { project: c.req.query("project"), release: c.req.query("release") })).map((t) =>
          task(c, t),
        ),
      ),
    ),
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

  // Agents working on the project's tasks right now: recent activity plus recent reads.
  app.get("/projects/:projectKey/presence", async (c) => {
    const actor = c.get("actor");
    const projectKey = c.req.param("projectKey");
    const since = new Date(Date.now() - PRESENCE_WINDOW_MS);
    const written = await activeAgentsInProject(db, actor, projectKey, since);
    return c.json(list(realtime.presence.merge(actor.orgId, projectKey, written, since)));
  });

  // An agent reading a task counts as working on it (not recorded in the activity log).
  app.get("/tasks/:taskKey", async (c) => {
    const actor = c.get("actor");
    const found = await getTask(db, actor, c.req.param("taskKey"));
    if (c.get("apiKey")) await realtime.presence.touch(actor, found.key);
    return c.json(task(c, found));
  });

  // Several tasks at once, by keys or a filter; per-task outcomes, 200 even when some fail (ST-106).
  app.post("/tasks/bulk-update", async (c) => {
    const result = await updateTasks(db, c.get("actor"), await body(c));
    return c.json({ ...result, results: result.results.map((r) => ({ ...r, task: r.task && task(c, r.task) })) });
  });

  app.patch("/tasks/:taskKey", async (c) =>
    c.json(task(c, await updateTask(db, c.get("actor"), c.req.param("taskKey"), await body(c)))),
  );

  app.get("/tasks/:taskKey/subtasks", async (c) =>
    c.json(list((await listSubtasks(db, c.get("actor"), c.req.param("taskKey"))).map((t) => task(c, t)))),
  );

  app.get("/tasks/:taskKey/relations", async (c) =>
    c.json(list(await listRelations(db, c.get("actor"), c.req.param("taskKey")))),
  );

  app.post("/tasks/:taskKey/relations", async (c) =>
    c.json(await addRelation(db, c.get("actor"), c.req.param("taskKey"), await body(c)), 201),
  );

  // Link as a duplicate, cancel and comment in one step; a repeat changes nothing (ST-114).
  app.post("/tasks/:taskKey/duplicate", async (c) =>
    c.json(task(c, await markDuplicate(db, c.get("actor"), c.req.param("taskKey"), await body(c)))),
  );

  // DELETE /tasks/ST-1/relations?kind=blocks&task=ST-2
  app.delete("/tasks/:taskKey/relations", async (c) => {
    await removeRelation(db, c.get("actor"), c.req.param("taskKey"), c.req.query());
    return c.body(null, 204);
  });

  app.get("/tasks/:taskKey/activity", async (c) =>
    c.json(list(await listTaskActivity(db, c.get("actor"), c.req.param("taskKey")))),
  );

  // Branches, commits and pull requests linked to the task from GitHub (ST-84).
  app.get("/tasks/:taskKey/git", async (c) => c.json(await getTaskGit(db, c.get("actor"), c.req.param("taskKey"))));

  // Documents mentioning the task: [[ST-12]] or a plain ST-12 (ST-101).
  app.get("/tasks/:taskKey/backlinks", async (c) =>
    c.json(list((await listTaskBacklinks(db, c.get("actor"), c.req.param("taskKey"))).map((d) => document(c, d)))),
  );

  app.get("/tasks/:taskKey/comments", async (c) => {
    const actor = c.get("actor");
    const taskKey = c.req.param("taskKey");
    const comments = await listComments(db, actor, taskKey);
    if (c.get("apiKey")) await realtime.presence.touch(actor, taskKey);
    return c.json(list(comments));
  });

  app.post("/tasks/:taskKey/comments", async (c) =>
    c.json(await addComment(db, c.get("actor"), c.req.param("taskKey"), await body(c)), 201),
  );

  // GET /documents?project=ST or ?task=ST-12; without either, the whole organization's.
  app.get("/documents", async (c) =>
    c.json(list((await listDocuments(db, c.get("actor"), c.req.query())).map((d) => document(c, d)))),
  );

  app.post("/documents", async (c) => c.json(document(c, await createDocument(db, c.get("actor"), await body(c))), 201));

  // Registered before /documents/:documentId, which would take "graph" for an id.
  app.get("/documents/graph", async (c) => {
    const graph = await getDocumentGraph(db, c.get("actor"));
    return c.json({ ...graph, documents: graph.documents.map((d) => document(c, d)), tasks: graph.tasks.map((t) => task(c, t)), projects: graph.projects.map((p) => project(c, p)) });
  });

  app.get("/documents/:documentId/backlinks", async (c) =>
    c.json(list((await listBacklinks(db, c.get("actor"), c.req.param("documentId"))).map((d) => document(c, d)))),
  );

  app.get("/documents/:documentId", async (c) =>
    c.json(document(c, await getDocument(db, c.get("actor"), c.req.param("documentId")))),
  );

  app.patch("/documents/:documentId", async (c) =>
    c.json(document(c, await updateDocument(db, c.get("actor"), c.req.param("documentId"), await body(c)))),
  );

  // POST { baseVersion?, edits: [{ old, new, all? } | { append } | { section, content }] }: partial edits (ST-116).
  app.post("/documents/:documentId/edit", async (c) =>
    c.json(document(c, await editDocument(db, c.get("actor"), c.req.param("documentId"), await body(c)))),
  );

  // POST { project: "KEY" | null }: move to a project, or make the document organization-wide.
  app.post("/documents/:documentId/move", async (c) =>
    c.json(document(c, await moveDocument(db, c.get("actor"), c.req.param("documentId"), await body(c)))),
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

  // Comments on a document (ST-118): on the whole document, or on a fragment ({ quote }).
  app.get("/documents/:documentId/comments", async (c) =>
    c.json(list(await listDocumentComments(db, c.get("actor"), c.req.param("documentId")))),
  );

  app.post("/documents/:documentId/comments", async (c) =>
    c.json(await addDocumentComment(db, c.get("actor"), c.req.param("documentId"), await body(c)), 201),
  );

  // PATCH { resolved: true | false }: resolve or reopen a thread (a top-level comment).
  app.patch("/documents/:documentId/comments/:commentId", async (c) =>
    c.json(
      await resolveDocumentComment(db, c.get("actor"), c.req.param("documentId"), c.req.param("commentId"), await body(c)),
    ),
  );

  // GET ?from=3&to=5: a line diff of two versions; without `to`, against the current one (ST-117).
  app.get("/documents/:documentId/diff", async (c) =>
    c.json(await diffDocumentVersions(db, c.get("actor"), c.req.param("documentId"), c.req.query())),
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
