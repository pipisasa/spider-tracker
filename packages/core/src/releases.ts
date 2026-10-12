import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, exists, inArray, isNull, not, notInArray, sql, type SQL } from "drizzle-orm";
import { assertCanWrite, inScope, orgIdOf, projectScope, type ActorContext, type ProjectScope, type Viewer } from "./access";
import { recordActivity } from "./activity";
import type { ReleaseAppDto, ReleaseDto, ReleaseTaskDto, TaskDto } from "./contracts";
import { deploymentDtos } from "./deployment-records";
import { DomainError } from "./errors";
import { publish } from "./events";
import { getProject } from "./projects";
import { repoFullName } from "./remotes";
import { findApp, findRepo, repoVisibleIn } from "./repos";
import {
  appVersionProblem,
  createReleaseInput,
  normalizeAppVersion,
  parseTaskKey,
  releaseCandidatesQuery,
  releaseListFilters,
  releaseTasksInput,
  updateReleaseInput,
  type ReleaseAppInput,
} from "./schemas";
import { createTaskIn, findTask, listTasks, toTaskDtos } from "./tasks";
import { parseInput } from "./validate";

// Releases (ST-93): tasks of kind "release". A release links repos and apps (a version each) and
// includes Done tasks from any project, one release per task (`tasks.release_id`). Marking it
// Released ships them (see shipping.ts). Members and their agents manage releases like other tasks;
// a project-scoped agent sees and adds only tasks of its own projects, and sees only the repos and
// apps (and their deployments) in repos attached to them (ST-92's rule). Hidden links stay as they
// are when it changes the others.

const { apps, gitLinks, projectRepos, projects, releaseApps, releaseRepos, repos, statuses, tasks } = schema;

type TaskRow = typeof tasks.$inferSelect;

/** At most this many candidates are listed. */
export const MAX_RELEASE_CANDIDATES = 200;

const keyOf = (projectKey: string, number: number) => `${projectKey}-${number}`;

/** A release the viewer can see, locked for a change inside a transaction with `forUpdate`. */
export async function findRelease(db: Db | Tx, viewer: Viewer, releaseKey: string, forUpdate = false) {
  const found = await findTask(db, viewer, releaseKey);
  if (found.task.kind !== "release") {
    throw new DomainError("validation", `${keyOf(found.projectKey, found.task.number)} is a ${found.task.kind}, not a release`);
  }
  if (!forUpdate) return found;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, found.task.id)).for("update");
  if (!task) throw new DomainError("not_found", `Task ${releaseKey} not found`);
  return { task, projectKey: found.projectKey };
}

async function categoryOf(db: Db | Tx, statusId: string) {
  const [status] = await db.select().from(statuses).where(eq(statuses.id, statusId)).limit(1);
  if (!status) throw new Error("Status missing");
  return status;
}

/** Tasks go into a release only while it is on its way (not Released or Canceled). */
async function assertOpen(db: Db | Tx, release: TaskRow, releaseKey: string, verb: string) {
  const status = await categoryOf(db, release.statusId);
  if (status.category === "done") throw new DomainError("validation", `Release ${releaseKey} is ${status.name}: its tasks have shipped, so none can be ${verb}`);
  if (status.category === "canceled") throw new DomainError("validation", `Release ${releaseKey} is ${status.name}; reopen it first`);
}

interface ResolvedLinks {
  /** The repos named in `repos`. */
  repos: { id: string; fullName: string }[];
  apps: { appId: string; repoId: string; label: string; version: string }[];
}

/**
 * The repos and apps named by `input`, as the creator can reach them: each repo must be visible to
 * them and attached to one of their projects (it may be another project than the release's).
 */
async function resolveLinks(tx: Tx, ctx: ActorContext, scope: ProjectScope, input: { repos?: string[]; apps?: ReleaseAppInput[] }) {
  const repoRows = new Map<string, Awaited<ReturnType<typeof findRepo>>>();
  const repo = async (ref: string) => {
    const row = await findRepo(tx, ctx, ref);
    if (!repoRows.has(row.id)) {
      const [attached] = await tx
        .select({ projectId: projectRepos.projectId })
        .from(projectRepos)
        .where(
          and(
            eq(projectRepos.repoId, row.id),
            scope ? (scope.size ? inArray(projectRepos.projectId, [...scope]) : sql`false`) : undefined,
          ),
        )
        .limit(1);
      if (!attached) {
        throw new DomainError("validation", `Repo ${repoFullName(row)} isn't attached to a project; attach it first (spider repo attach)`);
      }
      repoRows.set(row.id, row);
    }
    return row;
  };
  const links: ResolvedLinks = { repos: [], apps: [] };
  for (const ref of input.repos ?? []) {
    const row = await repo(ref);
    if (!links.repos.some((r) => r.id === row.id)) links.repos.push({ id: row.id, fullName: repoFullName(row) });
  }
  for (const item of input.apps ?? []) {
    const row = await repo(item.repo);
    const app = await findApp(tx, row, item.app);
    const problem = appVersionProblem(app.versioning, item.version);
    if (problem) throw new DomainError("validation", `${app.name}: ${problem}`);
    const version = normalizeAppVersion(app.versioning, item.version);
    links.apps.push({ appId: app.id, repoId: row.id, label: `${app.name} ${version}`, version });
  }
  return links;
}

/** Replaces the release's repo and app rows; an app's repo is always linked. */
async function writeLinks(tx: Tx, releaseId: string, repoIds: string[], appRows: { appId: string; version: string }[]) {
  await tx.delete(releaseApps).where(eq(releaseApps.releaseId, releaseId));
  await tx.delete(releaseRepos).where(eq(releaseRepos.releaseId, releaseId));
  if (repoIds.length) await tx.insert(releaseRepos).values([...new Set(repoIds)].map((repoId) => ({ releaseId, repoId })));
  if (appRows.length) await tx.insert(releaseApps).values(appRows.map((a) => ({ releaseId, appId: a.appId, version: a.version })));
}

/**
 * The release's links as they read in activity entries: "owner/name" and "web 2026.10.13", and
 * each app label's repo, which activity-feed.ts uses to hide the labels of repos a viewer can't see.
 */
async function linkLabels(db: Db | Tx, releaseId: string) {
  const repoRows = await db
    .select({ owner: repos.owner, name: repos.name })
    .from(releaseRepos)
    .innerJoin(repos, eq(repos.id, releaseRepos.repoId))
    .where(eq(releaseRepos.releaseId, releaseId));
  const appRows = await db
    .select({ name: apps.name, version: releaseApps.version, owner: repos.owner, repoName: repos.name })
    .from(releaseApps)
    .innerJoin(apps, eq(apps.id, releaseApps.appId))
    .innerJoin(repos, eq(repos.id, apps.repoId))
    .where(eq(releaseApps.releaseId, releaseId));
  const label = (a: { name: string; version: string }) => `${a.name} ${a.version}`;
  return {
    repos: repoRows.map(repoFullName).sort(),
    apps: appRows.map(label).sort(),
    appRepos: Object.fromEntries(appRows.map((a) => [label(a), repoFullName({ owner: a.owner, name: a.repoName })])),
  };
}

/** Activity changes for links going from `before` to `after`; `appRepos` names every app label's repo. */
function linkChanges(before: Awaited<ReturnType<typeof linkLabels>>, after: Awaited<ReturnType<typeof linkLabels>>) {
  const changes: Record<string, unknown> = {};
  if (before.repos.join("\n") !== after.repos.join("\n")) changes.repos = [before.repos, after.repos];
  if (before.apps.join("\n") !== after.apps.join("\n")) {
    changes.apps = [before.apps, after.apps];
    changes.appRepos = { ...before.appRepos, ...after.appRepos };
  }
  return changes;
}

/** Of these repo ids, the ones a viewer with `scope` can see. */
async function visibleRepoIds(db: Db | Tx, scope: ProjectScope, ids: string[]): Promise<Set<string>> {
  if (!scope) return new Set(ids);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(inArray(repos.id, ids), repoVisibleIn(db, scope)));
  return new Set(rows.map((r) => r.id));
}

/** The status and the in-scope repos, apps, included tasks and deployments of each release. */
async function toReleaseDtos(db: Db | Tx, scope: ProjectScope, releases: TaskDto[]): Promise<ReleaseDto[]> {
  if (releases.length === 0) return [];
  const ids = releases.map((r) => r.id);
  const statusRows = await db
    .select({ id: statuses.id, name: statuses.name, category: statuses.category })
    .from(statuses)
    .where(inArray(statuses.id, [...new Set(releases.map((r) => r.statusId))]));
  const repoRows = await db
    .select({ releaseId: releaseRepos.releaseId, id: repos.id, owner: repos.owner, name: repos.name })
    .from(releaseRepos)
    .innerJoin(repos, eq(repos.id, releaseRepos.repoId))
    .where(and(inArray(releaseRepos.releaseId, ids), repoVisibleIn(db, scope)))
    .orderBy(sql`lower(${repos.owner})`, sql`lower(${repos.name})`);
  const appRows = await db
    .select({
      releaseId: releaseApps.releaseId,
      version: releaseApps.version,
      app: apps,
      owner: repos.owner,
      repoName: repos.name,
    })
    .from(releaseApps)
    .innerJoin(apps, eq(apps.id, releaseApps.appId))
    .innerJoin(repos, eq(repos.id, apps.repoId))
    .where(and(inArray(releaseApps.releaseId, ids), repoVisibleIn(db, scope)))
    .orderBy(sql`lower(${repos.owner})`, sql`lower(${repos.name})`, asc(apps.name));
  const taskRows = await db
    .select({ task: tasks, projectKey: projects.key, status: { id: statuses.id, name: statuses.name, category: statuses.category } })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(inArray(tasks.releaseId, ids), isNull(tasks.deletedAt), scope ? inArray(tasks.projectId, [...scope]) : undefined))
    .orderBy(asc(projects.key), asc(tasks.number));
  const deploymentRows = await deploymentDtos(db, ids, undefined, scope);

  return releases.map((release) => {
    const status = statusRows.find((s) => s.id === release.statusId);
    if (!status) throw new Error("Release status missing");
    return {
      ...release,
      status,
      repos: repoRows.filter((r) => r.releaseId === release.id).map((r) => ({ id: r.id, fullName: repoFullName(r) })),
      apps: appRows
        .filter((a) => a.releaseId === release.id)
        .map(
          (a): ReleaseAppDto => ({
            appId: a.app.id,
            repo: repoFullName({ owner: a.owner, name: a.repoName }),
            name: a.app.name,
            versioning: a.app.versioning,
            environments: a.app.environments,
            version: a.version,
          }),
        ),
      tasks: taskRows
        .filter((t) => t.task.releaseId === release.id)
        .map(
          (t): ReleaseTaskDto => ({
            id: t.task.id,
            key: keyOf(t.projectKey, t.task.number),
            title: t.task.title,
            projectKey: t.projectKey,
            status: t.status,
            completedAt: t.task.completedAt?.toISOString() ?? null,
            shippedAt: t.task.shippedAt?.toISOString() ?? null,
          }),
        ),
      deployments: deploymentRows.filter((d) => d.releaseId === release.id),
    };
  });
}

export async function releaseDto(db: Db | Tx, viewer: Viewer, releaseKey: string): Promise<ReleaseDto> {
  const scope = await projectScope(db, viewer);
  const found = await findRelease(db, viewer, releaseKey);
  const [dto] = await toTaskDtos(db, scope, [found]);
  if (!dto) throw new Error("Failed to load release");
  const [release] = await toReleaseDtos(db, scope, [dto]);
  if (!release) throw new Error("Failed to load release");
  return release;
}

/** One release by its task key. */
export async function getRelease(db: Db, viewer: Viewer, releaseKey: string): Promise<ReleaseDto> {
  return releaseDto(db, viewer, releaseKey);
}

/** A project's releases in board order (by status, then position), optionally by status or app name. */
export async function listReleases(db: Db, viewer: Viewer, projectKey: string, filters: unknown = {}): Promise<ReleaseDto[]> {
  const { status, app } = parseInput(releaseListFilters, filters);
  const project = await getProject(db, viewer, projectKey);
  const rows = await listTasks(db, viewer, project.key, { kind: "release", status });
  const order = new Map(project.workflows.release.map((s, i) => [s.id, i]));
  rows.sort((a, b) => (order.get(a.statusId) ?? 0) - (order.get(b.statusId) ?? 0));
  const releases = await toReleaseDtos(db, await projectScope(db, viewer), rows);
  return app ? releases.filter((r) => r.apps.some((a) => a.name === app)) : releases;
}

/**
 * Creates a release in a project: a task of kind "release" (first todo status of the release
 * workflow unless `statusId` says otherwise) with its repos, apps and versions, and any Done tasks to include.
 */
export async function createRelease(db: Db, ctx: ActorContext, projectKey: string, input: unknown): Promise<ReleaseDto> {
  assertCanWrite(ctx);
  const data = parseInput(createReleaseInput, input);
  return db.transaction(async (tx) => {
    const scope = await projectScope(tx, ctx);
    const created = await createTaskIn(tx, ctx, projectKey, {
      kind: "release",
      title: data.title,
      description: data.description,
      statusId: data.statusId,
      assigneeIds: data.assigneeIds,
      startDate: data.startDate,
      targetDate: data.targetDate,
    });
    if (data.repos?.length || data.apps?.length) {
      const links = await resolveLinks(tx, ctx, scope, data);
      await writeLinks(tx, created.id, [...links.repos.map((r) => r.id), ...links.apps.map((a) => a.repoId)], links.apps);
      const after = await linkLabels(tx, created.id);
      await recordActivity(tx, ctx, {
        entityType: "task",
        entityId: created.id,
        action: "task.updated",
        changes: { repos: [[], after.repos], apps: [[], after.apps], appRepos: after.appRepos },
      });
    }
    if (data.tasks?.length) {
      const release = await findRelease(tx, ctx, created.key, true);
      await assertOpen(tx, release.task, created.key, "added");
      await addTasks(tx, ctx, release, data.tasks);
    }
    return releaseDto(tx, ctx, created.key);
  });
}

/**
 * Replaces a release's repos or apps (with their versions). Links in repos a scoped actor can't see
 * are kept: `repos: []` from it removes only the repos it sees.
 */
export async function updateRelease(db: Db, ctx: ActorContext, releaseKey: string, input: unknown): Promise<ReleaseDto> {
  assertCanWrite(ctx);
  const data = parseInput(updateReleaseInput, input);
  return db.transaction(async (tx) => {
    const scope = await projectScope(tx, ctx);
    const release = await findRelease(tx, ctx, releaseKey, true);
    const key = keyOf(release.projectKey, release.task.number);
    const before = await linkLabels(tx, release.task.id);

    const currentRepos = await tx.select({ repoId: releaseRepos.repoId }).from(releaseRepos).where(eq(releaseRepos.releaseId, release.task.id));
    const currentApps = await tx
      .select({ appId: releaseApps.appId, repoId: apps.repoId, version: releaseApps.version })
      .from(releaseApps)
      .innerJoin(apps, eq(apps.id, releaseApps.appId))
      .where(eq(releaseApps.releaseId, release.task.id));
    const visible = await visibleRepoIds(tx, scope, [...currentRepos.map((r) => r.repoId), ...currentApps.map((a) => a.repoId)]);
    const hiddenRepos = currentRepos.filter((r) => !visible.has(r.repoId)).map((r) => r.repoId);
    const hiddenApps = currentApps.filter((a) => !visible.has(a.repoId));
    const links = await resolveLinks(tx, ctx, scope, { repos: data.repos, apps: data.apps });
    const nextApps = data.apps ? [...hiddenApps, ...links.apps] : currentApps;
    const namedRepos = data.repos ? [...hiddenRepos, ...links.repos.map((r) => r.id)] : currentRepos.map((r) => r.repoId);
    await writeLinks(tx, release.task.id, [...namedRepos, ...nextApps.map((a) => a.repoId)], nextApps);

    const after = await linkLabels(tx, release.task.id);
    const changes = linkChanges(before, after);
    if (Object.keys(changes).length > 0) {
      await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, release.task.id));
      await recordActivity(tx, ctx, { entityType: "task", entityId: release.task.id, action: "task.updated", changes });
      await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: release.projectKey, taskKey: key });
    }
    return releaseDto(tx, ctx, key);
  });
}

/** Adds Done tasks to the locked, open release; tasks already in it are left as they are. */
async function addTasks(tx: Tx, ctx: ActorContext, release: { task: TaskRow; projectKey: string }, keys: string[]) {
  const releaseKey = keyOf(release.projectKey, release.task.number);
  const now = new Date();
  for (const key of [...new Set(keys.map(normalizeKey))]) {
    const found = await findTask(tx, ctx, key);
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, found.task.id)).for("update");
    if (!task) throw new DomainError("not_found", `Task ${key} not found`);
    const taskKey = keyOf(found.projectKey, task.number);
    if (task.kind !== "task") throw new DomainError("validation", `${taskKey} is a ${task.kind}; only tasks go into a release`);
    if (task.releaseId === release.task.id) continue;
    const status = await categoryOf(tx, task.statusId);
    if (status.category !== "done") {
      throw new DomainError("validation", `${taskKey} is ${status.name}, not Done; only Done tasks go into a release`);
    }
    if (task.shippedAt) throw new DomainError("conflict", `${taskKey} has already shipped`);
    if (task.releaseId) {
      const [other] = await tx
        .select({ number: tasks.number, title: tasks.title, projectId: tasks.projectId, projectKey: projects.key })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(eq(tasks.id, task.releaseId), isNull(tasks.deletedAt)))
        .limit(1);
      if (other) {
        const visible = inScope(await projectScope(tx, ctx), other.projectId);
        const name = visible ? `release ${keyOf(other.projectKey, other.number)} (${other.title})` : "another release";
        throw new DomainError("conflict", `${taskKey} is already in ${name}; a task ships in one release. Remove it there first`);
      }
    }
    await tx.update(tasks).set({ releaseId: release.task.id, updatedAt: now }).where(eq(tasks.id, task.id));
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.updated",
      changes: { releaseId: [task.releaseId, release.task.id] },
    });
    await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: found.projectKey, taskKey });
  }
  await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: release.projectKey, taskKey: releaseKey });
}

const normalizeKey = (key: string) => {
  const parsed = parseTaskKey(key.trim());
  return parsed ? keyOf(parsed.projectKey, parsed.number) : key.trim();
};

/**
 * Adds Done tasks (any project the actor can see) to a release that isn't Released or Canceled.
 * A task in another release is refused (one release per task); adding one twice changes nothing.
 * All or nothing: one task failing adds none.
 */
export async function addToRelease(db: Db, ctx: ActorContext, releaseKey: string, input: unknown): Promise<ReleaseDto> {
  assertCanWrite(ctx);
  const { tasks: keys } = parseInput(releaseTasksInput, input);
  return db.transaction(async (tx) => {
    const release = await findRelease(tx, ctx, releaseKey, true);
    const key = keyOf(release.projectKey, release.task.number);
    await assertOpen(tx, release.task, key, "added");
    await addTasks(tx, ctx, release, keys);
    return releaseDto(tx, ctx, key);
  });
}

/** Takes tasks out of a release that hasn't shipped; they become candidates again. All or nothing. */
export async function removeFromRelease(db: Db, ctx: ActorContext, releaseKey: string, input: unknown): Promise<ReleaseDto> {
  assertCanWrite(ctx);
  const { tasks: keys } = parseInput(releaseTasksInput, input);
  return db.transaction(async (tx) => {
    const release = await findRelease(tx, ctx, releaseKey, true);
    const key = keyOf(release.projectKey, release.task.number);
    await assertOpen(tx, release.task, key, "removed");
    const now = new Date();
    for (const ref of [...new Set(keys.map(normalizeKey))]) {
      const found = await findTask(tx, ctx, ref);
      const taskKey = keyOf(found.projectKey, found.task.number);
      if (found.task.releaseId !== release.task.id) throw new DomainError("validation", `${taskKey} isn't in release ${key}`);
      await tx.update(tasks).set({ releaseId: null, updatedAt: now }).where(eq(tasks.id, found.task.id));
      await recordActivity(tx, ctx, {
        entityType: "task",
        entityId: found.task.id,
        action: "task.updated",
        changes: { releaseId: [release.task.id, null] },
      });
      await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: found.projectKey, taskKey });
    }
    await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: release.projectKey, taskKey: key });
    return releaseDto(tx, ctx, key);
  });
}

/**
 * Done tasks that could go into a release: kind task, Done, with code (not marked no code), in no
 * release and not shipped; in the viewer's projects, or one `project`. Most recently finished
 * first, at most MAX_RELEASE_CANDIDATES.
 */
export async function listReleaseCandidates(db: Db, viewer: Viewer, query: unknown = {}): Promise<TaskDto[]> {
  const data = parseInput(releaseCandidatesQuery, query);
  const scope = await projectScope(db, viewer);
  const projectId = data.project ? (await getProject(db, viewer, data.project)).id : undefined;
  let elsewhere: SQL | undefined;
  if (data.release) {
    const release = await findRelease(db, viewer, data.release);
    // Git links (ST-84): when the release has repos, leave out tasks whose commits and pull
    // requests are all in other repos. Tasks without any (GitHub not connected, or not linked yet)
    // stay candidates; the manual noCode mark still decides "no code".
    const codeLink = (inReleaseRepos: boolean) =>
      exists(
        db
          .select({ one: sql`1` })
          .from(gitLinks)
          .where(
            and(
              eq(gitLinks.taskId, tasks.id),
              inArray(gitLinks.kind, ["commit", "pull_request"]),
              (inReleaseRepos ? inArray : notInArray)(
                gitLinks.repoId,
                db.select({ id: releaseRepos.repoId }).from(releaseRepos).where(eq(releaseRepos.releaseId, release.task.id)),
              ),
            ),
          ),
      );
    const [hasRepos] = await db.select({ id: releaseRepos.repoId }).from(releaseRepos).where(eq(releaseRepos.releaseId, release.task.id)).limit(1);
    if (hasRepos) elsewhere = and(codeLink(false), not(codeLink(true)));
  }
  if (scope && scope.size === 0) return [];
  const rows = await db
    .select({ task: tasks, projectKey: projects.key })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(
      and(
        eq(tasks.orgId, orgIdOf(viewer)),
        eq(tasks.kind, "task"),
        eq(statuses.category, "done"),
        eq(tasks.noCode, false),
        isNull(tasks.releaseId),
        isNull(tasks.shippedAt),
        isNull(tasks.deletedAt),
        projectId ? eq(tasks.projectId, projectId) : undefined,
        scope ? inArray(tasks.projectId, [...scope]) : undefined,
        elsewhere ? not(elsewhere) : undefined,
      ),
    )
    .orderBy(sql`${tasks.completedAt} desc nulls last`, desc(tasks.id))
    .limit(MAX_RELEASE_CANDIDATES);
  return toTaskDtos(db, scope, rows);
}
