import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { assertCanWrite, projectScope, type ActorContext, type ProjectScope, type Viewer } from "./access";
import { recordActivity } from "./activity";
import { systemContext } from "./bots";
import type { DeploymentDto, RecordDeploymentResponse, StatusCategory, StatusDto } from "./contracts";
import { deploymentDtos } from "./deployment-records";
import { DomainError } from "./errors";
import { publish } from "./events";
import { findRelease, releaseDto } from "./releases";
import { parseRepoRemote, repoFullName } from "./remotes";
import { repoVisibleIn } from "./repos";
import { deploymentListQuery, recordDeploymentInput } from "./schemas";
import { parseInput } from "./validate";

// Deployments (ST-94): a release's app deployed to one of the app's environments, recorded by
// `spider release deploy` (which scripts/deploy.ts runs after a manual deploy). The release's
// status follows its deployments, forward only:
// - its first deployment moves a release that hasn't started (Planned: backlog or todo) to the
//   first in_progress status of its workflow ("On staging"), as the Spider Tracker bot (source
//   "system"), like milestones moving to Ready to close; the deployment itself is the deployer's;
// - Released stays a person's (or the release owner's) move: it is allowed once every app with
//   environments is deployed to its last one (shipping.ts), never made automatically;
// - nothing moves a release backwards.
// A project-scoped agent sees and deploys only apps in repos attached to its projects (ST-92).

const { apps, deployments, releaseApps, repos, statuses, tasks } = schema;

/** Categories of a release that hasn't started: its first deployment moves it on. */
const NOT_STARTED: StatusCategory[] = ["backlog", "todo"];

/**
 * Records that the release's app was deployed to one of the app's environments at a commit, by
 * the actor. The app must be one the release ships; a canceled release takes no deployments.
 * The first deployment moves a Planned release to On staging (see above).
 */
export async function recordDeployment(db: Db, ctx: ActorContext, releaseKey: string, input: unknown): Promise<RecordDeploymentResponse> {
  assertCanWrite(ctx);
  const data = parseInput(recordDeploymentInput, input);
  return db.transaction(async (tx) => {
    const release = await findRelease(tx, ctx, releaseKey, true);
    const key = `${release.projectKey}-${release.task.number}`;
    const [status] = await tx
      .select({ id: statuses.id, name: statuses.name, category: statuses.category })
      .from(statuses)
      .where(eq(statuses.id, release.task.statusId))
      .limit(1);
    if (!status) throw new Error("Status missing");
    if (status.category === "canceled") throw new DomainError("validation", `Release ${key} is ${status.name}; reopen it before recording deployments`);

    const app = await releaseApp(tx, await projectScope(tx, ctx), release.task.id, key, data.app, data.repo);
    if (!app.environments.includes(data.environment)) {
      throw new DomainError(
        "validation",
        app.environments.length
          ? `${app.name} has no environment "${data.environment}"; its environments are ${app.environments.join(", ")}`
          : `${app.name} has no environments to deploy to (its release is its only "deploy"); add them with spider app update`,
      );
    }

    const [row] = await tx
      .insert(deployments)
      .values({
        orgId: ctx.orgId,
        releaseId: release.task.id,
        appId: app.id,
        environment: data.environment,
        commitSha: data.commitSha,
        actorId: ctx.actorId,
        source: ctx.source,
      })
      .returning({ id: deployments.id });
    if (!row) throw new Error("Failed to record the deployment");
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: release.task.id,
      action: "release.deployed",
      changes: { app: app.name, repo: app.repo, environment: data.environment, commitSha: data.commitSha },
    });

    const movedFrom = NOT_STARTED.includes(status.category) ? await startRelease(tx, ctx.orgId, release.task, status) : null;
    if (!movedFrom) await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, release.task.id));
    await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: release.projectKey, taskKey: key });

    const [deployment] = await deploymentDtos(tx, [release.task.id], eq(deployments.id, row.id));
    if (!deployment) throw new Error("Failed to load the deployment");
    return { deployment, release: await releaseDto(tx, ctx, key), movedFrom };
  });
}

/** The release's deployments, newest first, optionally of one app or environment. */
export async function listDeployments(db: Db, viewer: Viewer, releaseKey: string, query: unknown = {}): Promise<DeploymentDto[]> {
  const { app, environment } = parseInput(deploymentListQuery, query);
  const release = await findRelease(db, viewer, releaseKey);
  const scope = await projectScope(db, viewer);
  const rows = await deploymentDtos(db, [release.task.id], environment ? eq(deployments.environment, environment) : undefined, scope);
  return app ? rows.filter((d) => d.app === app) : rows;
}

/** The release's app named `name` (in `repo`, when given), or a validation error naming its apps; only apps in repos `scope` sees. */
async function releaseApp(tx: Tx, scope: ProjectScope, releaseId: string, releaseKey: string, name: string, repo: string | undefined) {
  const rows = await tx
    .select({ id: apps.id, name: apps.name, environments: apps.environments, owner: repos.owner, repoName: repos.name })
    .from(releaseApps)
    .innerJoin(apps, eq(apps.id, releaseApps.appId))
    .innerJoin(repos, eq(repos.id, apps.repoId))
    .where(and(eq(releaseApps.releaseId, releaseId), repoVisibleIn(tx, scope)))
    .orderBy(asc(repos.owner), asc(repos.name), asc(apps.name));
  const linked = rows.map((r) => ({ ...r, repo: repoFullName({ owner: r.owner, name: r.repoName }) }));
  let matches = linked.filter((a) => a.name === name);
  if (repo !== undefined) {
    const remote = parseRepoRemote(repo);
    const wanted = (remote ? repoFullName(remote) : repo).toLowerCase();
    matches = matches.filter((a) => a.repo.toLowerCase() === wanted);
  }
  const [only] = matches;
  if (only && matches.length === 1) return only;
  if (matches.length > 1) {
    throw new DomainError("validation", `Release ${releaseKey} ships ${name} from ${matches.map((a) => a.repo).join(" and ")}; name the repo`);
  }
  const shipped = linked.map((a) => `${a.name} (${a.repo})`).join(", ");
  throw new DomainError(
    "validation",
    `Release ${releaseKey} doesn't ship ${name}${repo ? ` from ${repo}` : ""}; ${shipped ? `it ships ${shipped}` : "it has no apps yet"}. Add the app first (spider release update ${releaseKey} --app ${name}=<version>)`,
  );
}

/**
 * Moves a release that hasn't started to the first in_progress status of its workflow ("On
 * staging"), as the Spider Tracker bot. Returns the status it left, or null when the workflow has
 * no such status (it then stays where it is).
 */
async function startRelease(
  tx: Tx,
  orgId: string,
  release: typeof tasks.$inferSelect,
  from: Pick<StatusDto, "id" | "name" | "category">,
): Promise<Pick<StatusDto, "id" | "name" | "category"> | null> {
  const [target] = await tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, release.projectId), eq(statuses.kind, "release"), eq(statuses.category, "in_progress")))
    .orderBy(asc(statuses.position))
    .limit(1);
  if (!target) return null;
  const [last] = await tx
    .select({ sortKey: tasks.sortKey })
    .from(tasks)
    .where(and(eq(tasks.projectId, release.projectId), eq(tasks.statusId, target.id), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.sortKey))
    .limit(1);
  await tx
    .update(tasks)
    .set({ statusId: target.id, sortKey: generateKeyBetween(last?.sortKey ?? null, null), updatedAt: new Date() })
    .where(eq(tasks.id, release.id));
  const bot = await systemContext(tx, orgId);
  await recordActivity(tx, bot, { entityType: "task", entityId: release.id, action: "task.updated", changes: { statusId: [release.statusId, target.id] } });
  return from;
}
