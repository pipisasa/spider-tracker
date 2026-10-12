import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, gte, inArray, isNull, max } from "drizzle-orm";
import { inScope, orgIdOf, projectScope, type Viewer } from "./access";
import type { PresenceDto } from "./contracts";
import { DomainError } from "./errors";

// Agent presence (ST-67): an agent is "working now" on a task when it acted on it recently.
// Writes are read from the activity log; reads are tracked in memory by the API.

const { activity, actors, documents, projects, tasks } = schema;

/** How long after its last action or read an agent still counts as working on a task. */
export const PRESENCE_WINDOW_MS = 10 * 60_000;

type TaskFilter = { projectKey: string } | { taskIds: string[] };

async function recentAgentActivity(db: Db, viewer: Viewer, filter: TaskFilter, since: Date): Promise<PresenceDto[]> {
  const scope = await projectScope(db, viewer);
  if (scope && scope.size === 0) return [];
  const orgId = orgIdOf(viewer);
  if ("taskIds" in filter && filter.taskIds.length === 0) return [];

  const where = and(
    eq(projects.orgId, orgId),
    isNull(tasks.deletedAt),
    "projectKey" in filter ? eq(projects.key, filter.projectKey.toUpperCase()) : inArray(tasks.id, filter.taskIds),
    scope ? inArray(projects.id, [...scope]) : undefined,
    eq(actors.type, "agent"),
    eq(activity.orgId, orgId),
    gte(activity.createdAt, since),
  );
  const columns = {
    projectKey: projects.key,
    number: tasks.number,
    taskId: tasks.id,
    actorId: activity.actorId,
    lastSeenAt: max(activity.createdAt),
  };
  const group = [projects.key, tasks.number, tasks.id, activity.actorId] as const;

  const [direct, viaDocuments] = await Promise.all([
    db
      .select(columns)
      .from(activity)
      .innerJoin(tasks, and(eq(activity.entityType, "task"), eq(activity.entityId, tasks.id)))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .innerJoin(actors, eq(activity.actorId, actors.id))
      .where(where)
      .groupBy(...group),
    db
      .select(columns)
      .from(activity)
      .innerJoin(documents, and(eq(activity.entityType, "document"), eq(activity.entityId, documents.id)))
      .innerJoin(tasks, eq(documents.taskId, tasks.id))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .innerJoin(actors, eq(activity.actorId, actors.id))
      .where(where)
      .groupBy(...group),
  ]);

  const latest = new Map<string, PresenceDto>();
  for (const r of [...direct, ...viaDocuments]) {
    if (!r.lastSeenAt) continue;
    const taskKey = `${r.projectKey}-${r.number}`;
    const id = `${taskKey}:${r.actorId}`;
    const seen = latest.get(id);
    if (!seen || seen.lastSeenAt < r.lastSeenAt.toISOString()) {
      latest.set(id, { taskKey, actorId: r.actorId, lastSeenAt: r.lastSeenAt.toISOString() });
    }
  }
  return [...latest.values()].sort((a, b) => (a.taskKey + a.actorId).localeCompare(b.taskKey + b.actorId));
}

/** Agents that acted on any of these tasks since `since` (tasks outside the viewer's scope are left out). */
export function activeAgentsForTasks(db: Db, viewer: Viewer, taskIds: string[], since: Date): Promise<PresenceDto[]> {
  return recentAgentActivity(db, viewer, { taskIds }, since);
}

/** Agents that acted on any task of a project since `since`; not_found when the project is outside the viewer's scope. */
export async function activeAgentsInProject(
  db: Db,
  viewer: Viewer,
  projectKey: string,
  since: Date,
): Promise<PresenceDto[]> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, orgIdOf(viewer)), eq(projects.key, projectKey.toUpperCase())))
    .limit(1);
  if (!project || !inScope(await projectScope(db, viewer), project.id)) {
    throw new DomainError("not_found", `Project ${projectKey} not found`);
  }
  return recentAgentActivity(db, viewer, { projectKey }, since);
}
