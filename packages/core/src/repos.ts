import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";
import {
  assertCanManageProjects,
  inScope,
  orgIdOf,
  projectScope,
  type ActorContext,
  type ProjectScope,
  type Viewer,
} from "./access";
import { recordActivity } from "./activity";
import type { AppDto, RepoDto } from "./contracts";
import { DomainError, isUniqueViolation } from "./errors";
import { publish } from "./events";
import { isUuid } from "./ids";
import { parseRepoRemote, repoFullName } from "./remotes";
import { attachRepoInput, createAppInput, createRepoInput, updateAppInput, updateRepoInput } from "./schemas";
import { parseInput } from "./validate";

// Repos and apps (ST-92). A repo belongs to the organization and is attached to projects; its apps
// are what releases (ST-93) version and deploy. Owners, admins and their agents manage them;
// everyone in the organization reads them, except that a project-scoped agent sees only the repos
// attached to its projects (and only those projects in a repo's `projects`).

const { apps, projectRepos, projects, repos } = schema;

type RepoRow = typeof repos.$inferSelect;
type AppRow = typeof apps.$inferSelect;

const toAppDto = (row: AppRow, repo: Pick<RepoRow, "owner" | "name">): AppDto => ({
  id: row.id,
  repoId: row.repoId,
  repo: repoFullName(repo),
  name: row.name,
  path: row.path,
  sharedPaths: row.sharedPaths,
  versioning: row.versioning,
  environments: row.environments,
  createdAt: row.createdAt.toISOString(),
});

/** Repos with their apps and the keys of their projects in `scope`. */
async function toRepoDtos(db: Db | Tx, rows: RepoRow[], scope: ProjectScope): Promise<RepoDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // One after the other: inside a transaction both share its connection.
  const appRows = await db.select().from(apps).where(inArray(apps.repoId, ids)).orderBy(asc(apps.name));
  const links = await db
    .select({ repoId: projectRepos.repoId, projectId: projects.id, key: projects.key })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(inArray(projectRepos.repoId, ids))
    .orderBy(asc(projects.key));
  return rows.map((repo) => ({
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: repoFullName(repo),
    defaultBranch: repo.defaultBranch,
    githubInstallationId: repo.githubInstallationId,
    projects: links.filter((l) => l.repoId === repo.id && inScope(scope, l.projectId)).map((l) => l.key),
    apps: appRows.filter((a) => a.repoId === repo.id).map((a) => toAppDto(a, repo)),
    createdAt: repo.createdAt.toISOString(),
  }));
}

/** A scoped viewer sees a repo only when it is attached to one of its projects. */
export function repoVisibleIn(db: Db | Tx, scope: ProjectScope): SQL | undefined {
  if (!scope) return undefined;
  if (scope.size === 0) return sql`false`;
  return exists(
    db
      .select({ one: sql`1` })
      .from(projectRepos)
      .where(and(eq(projectRepos.repoId, repos.id), inArray(projectRepos.projectId, [...scope]))),
  );
}

/** By id, "owner/name" or a remote URL, case-insensitively. */
function repoRefCondition(ref: string): SQL | null {
  const trimmed = ref.trim();
  if (isUuid(trimmed)) return eq(repos.id, trimmed);
  const remote = parseRepoRemote(trimmed);
  if (!remote) return null;
  return and(sql`lower(${repos.owner}) = ${remote.owner.toLowerCase()}`, sql`lower(${repos.name}) = ${remote.name.toLowerCase()}`) ?? null;
}

/** A repo the viewer can see; locked for a change inside a transaction with `forUpdate`. */
export async function findRepo(db: Db | Tx, viewer: Viewer, ref: string, forUpdate = false): Promise<RepoRow> {
  const condition = repoRefCondition(ref);
  const notFound = () => new DomainError("not_found", `Repo ${ref.trim()} not found`);
  if (!condition) throw notFound();
  const scope = await projectScope(db, viewer);
  const query = db
    .select()
    .from(repos)
    .where(and(eq(repos.orgId, orgIdOf(viewer)), condition, repoVisibleIn(db, scope)))
    .limit(1);
  const [row] = forUpdate ? await query.for("update") : await query;
  if (!row) throw notFound();
  return row;
}

/** A project the viewer can see, by key. */
async function findProject(db: Db | Tx, viewer: Viewer, key: string) {
  const [project] = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(and(eq(projects.orgId, orgIdOf(viewer)), eq(projects.key, key.trim().toUpperCase())))
    .limit(1);
  if (!project || !inScope(await projectScope(db, viewer), project.id)) {
    throw new DomainError("not_found", `Project ${key.trim()} not found`);
  }
  return project;
}

async function repoDto(db: Db | Tx, viewer: Viewer, row: RepoRow): Promise<RepoDto> {
  const [dto] = await toRepoDtos(db, [row], await projectScope(db, viewer));
  if (!dto) throw new Error("Failed to load repo");
  return dto;
}

const conflictOnRemote = (fullName: string) => (err: unknown) => {
  if (isUniqueViolation(err, "repos_org_remote_key")) throw new DomainError("conflict", `Repo ${fullName} already exists`);
  throw err;
};

/** The organization's repos the viewer can see, by name; only those attached to `project` when given. */
export async function listRepos(db: Db, viewer: Viewer, { project }: { project?: string } = {}): Promise<RepoDto[]> {
  const scope = await projectScope(db, viewer);
  const projectId = project ? (await findProject(db, viewer, project)).id : undefined;
  const rows = await db
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.orgId, orgIdOf(viewer)),
        repoVisibleIn(db, scope),
        projectId === undefined
          ? undefined
          : exists(
              db
                .select({ one: sql`1` })
                .from(projectRepos)
                .where(and(eq(projectRepos.repoId, repos.id), eq(projectRepos.projectId, projectId))),
            ),
      ),
    )
    .orderBy(sql`lower(${repos.owner})`, sql`lower(${repos.name})`);
  return toRepoDtos(db, rows, scope);
}

/** One repo by id, "owner/name" or remote URL. */
export async function getRepo(db: Db, viewer: Viewer, ref: string): Promise<RepoDto> {
  return repoDto(db, viewer, await findRepo(db, viewer, ref));
}

/**
 * Adds a repo by its remote URL (or "owner/name"), optionally attached to projects. A
 * project-scoped agent must attach it to one of its projects, or it couldn't see it afterwards.
 */
export async function createRepo(db: Db, ctx: ActorContext, input: unknown): Promise<RepoDto> {
  await assertCanManageProjects(db, ctx, "add repos");
  const data = parseInput(createRepoInput, input);
  const fullName = repoFullName(data.url);
  const keys = [...new Set(data.projects ?? [])];
  if ((await projectScope(db, ctx)) && keys.length === 0) {
    throw new DomainError("validation", "projects: Attach the repo to one of your projects");
  }

  return db
    .transaction(async (tx) => {
      const attached: { id: string; key: string }[] = [];
      for (const key of keys) attached.push(await findProject(tx, ctx, key));
      const row = await insertRepo(tx, ctx, {
        owner: data.url.owner,
        name: data.url.name,
        defaultBranch: data.defaultBranch ?? "main",
        projects: attached,
      });
      if (!row) throw new DomainError("conflict", `Repo ${fullName} already exists`);
      await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
      return repoDto(tx, ctx, row);
    })
    .catch(conflictOnRemote(fullName));
}

/**
 * Inserts a repo, attaches it to `projects` and records `repo.created`, inside the caller's
 * transaction; null when the organization already has that remote. No permission check: callers
 * do it (createRepo; the GitHub App for repos an installation grants, ST-82).
 */
export async function insertRepo(
  tx: Tx,
  ctx: ActorContext,
  data: {
    owner: string;
    name: string;
    defaultBranch: string;
    projects?: { id: string; key: string }[];
    githubInstallationId?: number | null;
  },
): Promise<RepoRow | null> {
  const [row] = await tx
    .insert(repos)
    .values({
      orgId: ctx.orgId,
      owner: data.owner,
      name: data.name,
      defaultBranch: data.defaultBranch,
      githubInstallationId: data.githubInstallationId ?? null,
      createdBy: ctx.actorId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  const attached = data.projects ?? [];
  if (attached.length) await tx.insert(projectRepos).values(attached.map((p) => ({ projectId: p.id, repoId: row.id })));
  await recordActivity(tx, ctx, {
    entityType: "repo",
    entityId: row.id,
    action: "repo.created",
    changes: {
      repo: repoFullName(row),
      defaultBranch: row.defaultBranch,
      projects: attached.map((p) => p.key),
      ...(row.githubInstallationId === null ? {} : { githubInstallationId: row.githubInstallationId }),
    },
  });
  return row;
}

/** Changes a repo's remote (after a rename on GitHub) or default branch. */
export async function updateRepo(db: Db, ctx: ActorContext, ref: string, input: unknown): Promise<RepoDto> {
  await assertCanManageProjects(db, ctx, "change repos");
  const data = parseInput(updateRepoInput, input);
  const fullName = data.url ? repoFullName(data.url) : ref;

  return db
    .transaction(async (tx) => {
      const current = await findRepo(tx, ctx, ref, true);
      const next = {
        owner: data.url?.owner ?? current.owner,
        name: data.url?.name ?? current.name,
        defaultBranch: data.defaultBranch ?? current.defaultBranch,
      };
      const changes: Record<string, [unknown, unknown]> = {};
      if (repoFullName(next) !== repoFullName(current)) changes.repo = [repoFullName(current), repoFullName(next)];
      if (next.defaultBranch !== current.defaultBranch) changes.defaultBranch = [current.defaultBranch, next.defaultBranch];
      if (Object.keys(changes).length === 0) return repoDto(tx, ctx, current);

      const [row] = await tx.update(repos).set(next).where(eq(repos.id, current.id)).returning();
      if (!row) throw new Error("Failed to update repo");
      await recordActivity(tx, ctx, { entityType: "repo", entityId: row.id, action: "repo.updated", changes });
      await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
      return repoDto(tx, ctx, row);
    })
    .catch(conflictOnRemote(fullName));
}

/**
 * Removes a repo with its apps and project links. A project-scoped agent can't remove a repo
 * that other projects use too.
 */
export async function deleteRepo(db: Db, ctx: ActorContext, ref: string): Promise<void> {
  await assertCanManageProjects(db, ctx, "remove repos");
  await db.transaction(async (tx) => {
    const repo = await findRepo(tx, ctx, ref, true);
    const scope = await projectScope(tx, ctx);
    if (scope) {
      const links = await tx.select({ projectId: projectRepos.projectId }).from(projectRepos).where(eq(projectRepos.repoId, repo.id));
      if (links.some((l) => !scope.has(l.projectId))) {
        throw new DomainError("forbidden", `Repo ${repoFullName(repo)} is also used by projects you can't see`);
      }
    }
    await tx.delete(repos).where(eq(repos.id, repo.id));
    await recordActivity(tx, ctx, {
      entityType: "repo",
      entityId: repo.id,
      action: "repo.deleted",
      changes: { repo: repoFullName(repo) },
    });
    await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
  });
}

/** Attaches a repo to a project; attaching it again changes nothing. */
export async function attachRepo(db: Db, ctx: ActorContext, projectKey: string, input: unknown): Promise<RepoDto> {
  await assertCanManageProjects(db, ctx, "attach repos");
  const { repo: ref } = parseInput(attachRepoInput, input);
  return db.transaction(async (tx) => {
    const project = await findProject(tx, ctx, projectKey);
    const repo = await findRepo(tx, ctx, ref, true);
    const [linked] = await tx
      .insert(projectRepos)
      .values({ projectId: project.id, repoId: repo.id })
      .onConflictDoNothing()
      .returning();
    if (linked) {
      await recordActivity(tx, ctx, {
        entityType: "repo",
        entityId: repo.id,
        action: "repo.attached",
        changes: { repo: repoFullName(repo), project: project.key },
      });
      await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
    }
    return repoDto(tx, ctx, repo);
  });
}

/** Detaches a repo from a project; detaching one that isn't attached changes nothing. */
export async function detachRepo(db: Db, ctx: ActorContext, projectKey: string, ref: string): Promise<RepoDto> {
  await assertCanManageProjects(db, ctx, "detach repos");
  return db.transaction(async (tx) => {
    const project = await findProject(tx, ctx, projectKey);
    const repo = await findRepo(tx, ctx, ref, true);
    const [unlinked] = await tx
      .delete(projectRepos)
      .where(and(eq(projectRepos.projectId, project.id), eq(projectRepos.repoId, repo.id)))
      .returning();
    if (unlinked) {
      await recordActivity(tx, ctx, {
        entityType: "repo",
        entityId: repo.id,
        action: "repo.detached",
        changes: { repo: repoFullName(repo), project: project.key },
      });
      await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
    }
    return repoDto(tx, ctx, repo);
  });
}

export async function findApp(tx: Tx, repo: RepoRow, name: string): Promise<AppRow> {
  const [row] = await tx
    .select()
    .from(apps)
    .where(and(eq(apps.repoId, repo.id), eq(apps.name, name.trim().toLowerCase())))
    .limit(1);
  if (!row) throw new DomainError("not_found", `App ${name.trim()} not found in ${repoFullName(repo)}`);
  return row;
}

const conflictOnAppName = (name: string, repo: string) => (err: unknown) => {
  if (isUniqueViolation(err, "apps_repo_name_key")) throw new DomainError("conflict", `App ${name} already exists in ${repo}`);
  throw err;
};

/** Adds an app to a repo: its folder, shared packages, versioning (default semver) and environments in deploy order. */
export async function createApp(db: Db, ctx: ActorContext, repoRef: string, input: unknown): Promise<AppDto> {
  await assertCanManageProjects(db, ctx, "add apps");
  const data = parseInput(createAppInput, input);
  return db.transaction(async (tx) => {
    const repo = await findRepo(tx, ctx, repoRef, true);
    const [row] = await tx
      .insert(apps)
      .values({
        repoId: repo.id,
        name: data.name,
        path: data.path,
        sharedPaths: data.sharedPaths ?? [],
        versioning: data.versioning ?? "semver",
        environments: data.environments ?? [],
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new DomainError("conflict", `App ${data.name} already exists in ${repoFullName(repo)}`);
    const app = toAppDto(row, repo);
    await recordActivity(tx, ctx, {
      entityType: "app",
      entityId: row.id,
      action: "app.created",
      changes: {
        repo: app.repo,
        name: app.name,
        path: app.path,
        sharedPaths: app.sharedPaths,
        versioning: app.versioning,
        environments: app.environments,
      },
    });
    await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
    return app;
  });
}

/** Renames an app or changes its paths, versioning or environments. */
export async function updateApp(db: Db, ctx: ActorContext, repoRef: string, appName: string, input: unknown): Promise<AppDto> {
  await assertCanManageProjects(db, ctx, "change apps");
  const data = parseInput(updateAppInput, input);
  return db
    .transaction(async (tx) => {
      const repo = await findRepo(tx, ctx, repoRef, true);
      const current = await findApp(tx, repo, appName);
      const next = {
        name: data.name ?? current.name,
        path: data.path ?? current.path,
        sharedPaths: data.sharedPaths ?? current.sharedPaths,
        versioning: data.versioning ?? current.versioning,
        environments: data.environments ?? current.environments,
      };
      const changes: Record<string, [unknown, unknown]> = {};
      for (const field of ["name", "path", "versioning"] as const) {
        if (next[field] !== current[field]) changes[field] = [current[field], next[field]];
      }
      for (const field of ["sharedPaths", "environments"] as const) {
        if (next[field].join("\n") !== current[field].join("\n")) changes[field] = [current[field], next[field]];
      }
      if (Object.keys(changes).length === 0) return toAppDto(current, repo);

      const [row] = await tx.update(apps).set(next).where(eq(apps.id, current.id)).returning();
      if (!row) throw new Error("Failed to update app");
      await recordActivity(tx, ctx, {
        entityType: "app",
        entityId: row.id,
        action: "app.updated",
        changes: { repo: repoFullName(repo), ...changes },
      });
      await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
      return toAppDto(row, repo);
    })
    .catch(conflictOnAppName(data.name ?? appName, repoRef));
}

export async function deleteApp(db: Db, ctx: ActorContext, repoRef: string, appName: string): Promise<void> {
  await assertCanManageProjects(db, ctx, "remove apps");
  await db.transaction(async (tx) => {
    const repo = await findRepo(tx, ctx, repoRef, true);
    const app = await findApp(tx, repo, appName);
    await tx.delete(apps).where(eq(apps.id, app.id));
    await recordActivity(tx, ctx, {
      entityType: "app",
      entityId: app.id,
      action: "app.deleted",
      changes: { repo: repoFullName(repo), name: app.name },
    });
    await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
  });
}
