import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { inScope, orgIdOf, projectScope, type ProjectScope, type Viewer } from "./access";
import type { ActivityDto } from "./contracts";
import { repoFullName } from "./remotes";
import { repoVisibleIn } from "./repos";
import { parseTaskKey } from "./schemas";
import { findTask } from "./tasks";

const { activity, apps, projects, repos, tasks } = schema;

/** What the id of a release the viewer can't see reads as in `releaseId` changes. */
export const HIDDEN_RELEASE = "hidden";

type Changes = Record<string, unknown>;

/** A task's history, oldest first (task and comment events), as the viewer may see it. */
export async function listTaskActivity(db: Db, viewer: Viewer, taskKey: string): Promise<ActivityDto[]> {
  const { task } = await findTask(db, viewer, taskKey);
  const rows = await db
    .select()
    .from(activity)
    .where(and(eq(activity.orgId, orgIdOf(viewer)), eq(activity.entityType, "task"), eq(activity.entityId, task.id)))
    .orderBy(asc(activity.id));
  const view = await activityView(
    db,
    viewer,
    rows.map((r) => ({ action: r.action, changes: r.changes ?? null })),
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    changes: view(r.action, r.changes ?? null),
    source: r.source,
    actorId: r.actorId,
    createdAt: r.createdAt.toISOString(),
  }));
}

const isRecord = (value: unknown): value is Changes => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const isShipping = (action: string) => action === "task.shipped" || action === "task.unshipped";
const NO_RELEASE = { releaseId: null, release: null, version: null };

/**
 * How activity changes read for a viewer (ST-93, ST-94):
 * - "task.shipped"/"task.unshipped" store the release's id (older entries its key and version); they
 *   read as `{ releaseId, release: <key>, version: <title> }`, all null when the viewer can't see it;
 * - a `releaseId` change naming a release the viewer can't see reads as "hidden";
 * - a release's `repos` and `apps` keep only those in repos the viewer can see, and "release.deployed"
 *   of an app in a hidden repo reads with nulls. `appRepos` (each app label's repo) is never returned.
 */
async function activityView(db: Db, viewer: Viewer, entries: { action: string; changes: Changes | null }[]) {
  const orgId = orgIdOf(viewer);
  const scope = await projectScope(db, viewer);
  const releaseIds = new Set<string>();
  const releaseKeys = new Set<string>();
  let links = false;
  for (const { action, changes } of entries) {
    if (!changes) continue;
    if (isShipping(action)) {
      if (typeof changes.releaseId === "string") releaseIds.add(changes.releaseId);
      else if (typeof changes.release === "string") releaseKeys.add(changes.release);
    }
    if (Array.isArray(changes.releaseId)) for (const id of strings(changes.releaseId)) releaseIds.add(id);
    if (changes.repos !== undefined || changes.apps !== undefined || action === "release.deployed") links = true;
  }
  const releases = await releasesById(db, orgId, releaseIds);
  const keysSeen = await releaseKeysInScope(db, orgId, scope, releaseKeys);
  const seen = scope && links ? await visibleRepos(db, orgId, scope) : null;
  const sees = (releaseId: string) => {
    const release = releases.get(releaseId);
    return release && inScope(scope, release.projectId) ? release : null;
  };

  return (action: string, changes: Changes | null): Changes | null => {
    if (!changes) return null;
    if (isShipping(action)) {
      if (typeof changes.releaseId === "string") {
        const release = sees(changes.releaseId);
        return release ? { releaseId: changes.releaseId, release: release.key, version: release.title } : NO_RELEASE;
      }
      return typeof changes.release === "string" && keysSeen.has(changes.release)
        ? { releaseId: null, release: changes.release, version: changes.version ?? null }
        : NO_RELEASE;
    }
    const out: Changes = { ...changes };
    delete out.appRepos;
    if (Array.isArray(changes.releaseId)) {
      out.releaseId = changes.releaseId.map((id: unknown) => (typeof id === "string" && !sees(id) ? HIDDEN_RELEASE : id));
    }
    if (!seen) return out;
    if (action === "release.deployed") {
      const visible = typeof changes.repo === "string" && seen.repos.has(changes.repo.toLowerCase());
      return visible ? out : { ...out, app: null, repo: null, environment: null, commitSha: null };
    }
    const appRepos = isRecord(changes.appRepos) ? changes.appRepos : null;
    const seesApp = (label: string) => {
      const repo = appRepos?.[label];
      if (typeof repo === "string") return seen.repos.has(repo.toLowerCase());
      // Older entries don't name an app's repo: an app of that name in a visible repo is enough.
      return seen.apps.has(label.slice(0, label.lastIndexOf(" ")));
    };
    const keep: Record<"repos" | "apps", (label: string) => boolean> = {
      repos: (name) => seen.repos.has(name.toLowerCase()),
      apps: seesApp,
    };
    for (const field of ["repos", "apps"] as const) {
      const value = changes[field];
      if (!Array.isArray(value) || value.length !== 2) continue;
      const before = strings(value[0]).filter(keep[field]);
      const after = strings(value[1]).filter(keep[field]);
      if (before.join("\n") === after.join("\n")) delete out[field];
      else out[field] = [before, after];
    }
    return out;
  };
}

/** Releases by id, deleted ones too: history names them as they are now. */
async function releasesById(db: Db, orgId: string, ids: Set<string>) {
  const found = new Map<string, { key: string; title: string; projectId: string }>();
  if (ids.size === 0) return found;
  const rows = await db
    .select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.orgId, orgId), inArray(tasks.id, [...ids])));
  for (const r of rows) found.set(r.id, { key: `${r.projectKey}-${r.number}`, title: r.title, projectId: r.projectId });
  return found;
}

/** Of these release keys (from older entries), the ones in projects the viewer can see. */
async function releaseKeysInScope(db: Db, orgId: string, scope: ProjectScope, keys: Set<string>): Promise<Set<string>> {
  if (!scope) return keys;
  const projectKeys = [...new Set([...keys].flatMap((k) => parseTaskKey(k)?.projectKey ?? []))];
  if (projectKeys.length === 0) return new Set();
  const rows = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), inArray(projects.key, projectKeys)));
  const visible = new Set(rows.filter((p) => inScope(scope, p.id)).map((p) => p.key));
  return new Set([...keys].filter((k) => visible.has(parseTaskKey(k)?.projectKey ?? "")));
}

/** The repos ("owner/name", lower case) and the names of their apps that a scoped viewer can see. */
async function visibleRepos(db: Db, orgId: string, scope: ProjectScope) {
  const rows = await db
    .select({ owner: repos.owner, name: repos.name, app: apps.name })
    .from(repos)
    .leftJoin(apps, eq(apps.repoId, repos.id))
    .where(and(eq(repos.orgId, orgId), repoVisibleIn(db, scope)));
  return {
    repos: new Set(rows.map((r) => repoFullName(r).toLowerCase())),
    apps: new Set(rows.flatMap((r) => (r.app ? [r.app] : []))),
  };
}
