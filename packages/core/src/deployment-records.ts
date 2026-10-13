import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { ProjectScope } from "./access";
import type { DeploymentDto } from "./contracts";
import { repoFullName } from "./remotes";
import { repoVisibleIn } from "./repos";

// Deployment rows (ST-94) as release DTOs carry them, and the check that a release may be marked
// Released. Kept apart from deployments.ts so releases.ts and shipping.ts can use them without an
// import cycle.

const { actors, apps, deployments, releaseApps, repos, tasks, projects } =
  schema;

/** An app's production: its last environment ("prod" in [staging, prod]); null with none (a CLI). */
export const productionOf = (environments: string[]): string | null =>
  environments.at(-1) ?? null;

/**
 * Deployments of these releases, newest first, optionally narrowed by `where`. With a `scope`, only
 * deployments of apps in repos the viewer can see (ST-92's rule).
 */
export async function deploymentDtos(
  db: Db | Tx,
  releaseIds: string[],
  where?: SQL,
  scope: ProjectScope = null,
): Promise<DeploymentDto[]> {
  if (releaseIds.length === 0) return [];
  const rows = await db
    .select({
      deployment: deployments,
      releaseNumber: tasks.number,
      projectKey: projects.key,
      app: { name: apps.name, environments: apps.environments },
      owner: repos.owner,
      repoName: repos.name,
      actor: { id: actors.id, handle: actors.handle, name: actors.name },
    })
    .from(deployments)
    .innerJoin(tasks, eq(tasks.id, deployments.releaseId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .innerJoin(repos, eq(repos.id, apps.repoId))
    .leftJoin(actors, eq(actors.id, deployments.actorId))
    .where(
      and(
        inArray(deployments.releaseId, releaseIds),
        where,
        repoVisibleIn(db, scope),
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deployments.id));
  return rows.map((r): DeploymentDto => ({
    id: r.deployment.id,
    releaseId: r.deployment.releaseId,
    releaseKey: `${r.projectKey}-${r.releaseNumber}`,
    appId: r.deployment.appId,
    app: r.app.name,
    repo: repoFullName({ owner: r.owner, name: r.repoName }),
    environment: r.deployment.environment,
    production: productionOf(r.app.environments) === r.deployment.environment,
    commitSha: r.deployment.commitSha,
    deployedBy: r.actor?.id
      ? { id: r.actor.id, handle: r.actor.handle, name: r.actor.name }
      : null,
    source: r.deployment.source,
    createdAt: r.deployment.createdAt.toISOString(),
  }));
}

/**
 * The release's apps that aren't in production yet: apps with environments and no deployment of
 * this release to their last one. Apps without environments (a CLI: its GitHub release is its
 * "prod") never block. By name; `visible` says whether a viewer with `scope` can see the app's repo.
 */
export async function appsNotInProduction(
  db: Db | Tx,
  releaseId: string,
  scope: ProjectScope = null,
): Promise<{ name: string; production: string; visible: boolean }[]> {
  const visible = repoVisibleIn(db, scope);
  const linked = await db
    .select({
      id: apps.id,
      name: apps.name,
      environments: apps.environments,
      visible: visible ? sql<boolean>`${visible}` : sql<boolean>`true`,
    })
    .from(releaseApps)
    .innerJoin(apps, eq(apps.id, releaseApps.appId))
    .innerJoin(repos, eq(repos.id, apps.repoId))
    .where(eq(releaseApps.releaseId, releaseId))
    .orderBy(asc(apps.name));
  const pending: { name: string; production: string; visible: boolean }[] = [];
  for (const app of linked) {
    const production = productionOf(app.environments);
    if (!production) continue;
    const [deployed] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.releaseId, releaseId),
          eq(deployments.appId, app.id),
          eq(deployments.environment, production),
        ),
      )
      .limit(1);
    if (!deployed)
      pending.push({ name: app.name, production, visible: app.visible });
  }
  return pending;
}
