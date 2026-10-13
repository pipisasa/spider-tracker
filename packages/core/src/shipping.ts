import type { Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { ActorContext, ProjectScope } from "./access";
import { recordActivity } from "./activity";
import type { StatusCategory } from "./contracts";
import { appsNotInProduction } from "./deployment-records";
import { DomainError } from "./errors";
import { publish } from "./events";
import { effectiveMilestones, settleMilestones } from "./milestone-membership";
import { allReleaseTasks, assertSeesWholeRelease } from "./release-scope";

// Shipping (ST-93): what a release's status does to the Done tasks it includes. Done means
// finished; a task has shipped once its release is Released (category done). Status changes of
// the tasks themselves are untouched: they are already Done.
//
// These changes write to every included task, so a project-scoped actor makes them only when it can
// see all of them (release-scope.ts). The Spider Tracker bot sees every project. Activity entries
// on the included tasks hold the release's id only; activity-feed.ts resolves its key and version
// for each viewer, so a release the viewer can't see isn't named.

const { projects, tasks } = schema;

interface ReleaseRow {
  id: string;
  key: string;
  /** The status the caller read, before the change. */
  statusId: string;
}

async function announce(
  tx: Tx,
  ctx: ActorContext,
  task: { number: number; projectKey: string },
) {
  await publish(tx, {
    type: "task.changed",
    orgId: ctx.orgId,
    projectKey: task.projectKey,
    taskKey: `${task.projectKey}-${task.number}`,
  });
}

/**
 * Runs when a release's status changes category, inside the update's transaction:
 * - into done (Released): every included task must be Done, and every app of the release that has
 *   environments must be deployed (by this release) to its last one, its production (ST-94); the
 *   tasks get `shippedAt` (the release time) and a "task.shipped" activity entry, "shipped in <version>";
 * - out of done: the shipping is undone ("task.unshipped");
 * - into canceled: the included tasks leave the release, free for another one.
 * Any of these is refused when an included task is outside the actor's `scope`. The release row is
 * locked first, as adding and removing tasks do (releases.ts), so no task joins or leaves between
 * the scope check and the writes, and the writes touch only the tasks that were checked.
 * Returns the release's own `shippedAt` when it changes (undefined when it doesn't).
 */
export async function applyReleaseTransition(
  tx: Tx,
  ctx: ActorContext,
  scope: ProjectScope,
  release: ReleaseRow,
  from: StatusCategory,
  to: StatusCategory,
  now: Date,
): Promise<Date | null | undefined> {
  if (from === to) return undefined;
  if (to !== "done" && from !== "done" && to !== "canceled") return undefined;
  // Lock order: the release row, then its tasks (as addToRelease and removeFromRelease take them).
  const [locked] = await tx
    .select({ statusId: tasks.statusId })
    .from(tasks)
    .where(eq(tasks.id, release.id))
    .for("update");
  if (!locked)
    throw new DomainError("not_found", `Task ${release.key} not found`);
  // Another change moved it while this one waited for the lock: `from` is no longer true.
  if (locked.statusId !== release.statusId)
    throw new DomainError(
      "conflict",
      `Release ${release.key} changed meanwhile; try again`,
    );
  const included = await allReleaseTasks(tx, release.id);
  const includedIds = included.map((t) => t.id);
  assertSeesWholeRelease(
    scope,
    release.key,
    included,
    to === "done" ? "release it" : to === "canceled" ? "cancel it" : "move it",
  );
  const shippedIn = { releaseId: release.id };
  let shippedAt: Date | null | undefined;

  if (to === "done") {
    const unfinished = included.filter((t) => t.category !== "done");
    if (unfinished.length > 0) {
      throw new DomainError(
        "validation",
        `Release ${release.key} can't be released: ${unfinished.map((t) => `${t.projectKey}-${t.number}`).join(", ")} ${unfinished.length === 1 ? "isn't" : "aren't"} Done. Finish or remove ${unfinished.length === 1 ? "it" : "them"} first`,
      );
    }
    // Released follows deployments (ST-94): allowed once every app is in production, never automatic.
    const pending = await appsNotInProduction(tx, release.id, scope);
    const shown = pending.filter((a) => a.visible);
    if (shown.length < pending.length) {
      throw new DomainError(
        "forbidden",
        `Release ${release.key} ships apps in repos you can't see that aren't deployed yet; ask a member to release it`,
      );
    }
    if (pending.length > 0) {
      const names = pending
        .map((a) => `${a.name} to ${a.production}`)
        .join(", ");
      const [first] = pending;
      throw new DomainError(
        "validation",
        `Release ${release.key} can't be released: it isn't deployed ${names} yet. Record each deploy first (spider release deploy ${release.key} --app ${first?.name} --env ${first?.production})`,
      );
    }
    const shipping = included.filter((t) => !t.shippedAt);
    for (const task of shipping) {
      await tx
        .update(tasks)
        .set({ shippedAt: now, updatedAt: now })
        .where(eq(tasks.id, task.id));
      await recordActivity(tx, ctx, {
        entityType: "task",
        entityId: task.id,
        action: "task.shipped",
        changes: shippedIn,
      });
      await announce(tx, ctx, task);
    }
    // Shipping their code may complete the tasks' milestones (ST-96).
    const memberships = await effectiveMilestones(
      tx,
      shipping.map((t) => t.id),
    );
    await settleMilestones(
      tx,
      ctx.orgId,
      [...memberships.values()].map((m) => m.milestoneId),
    );
    shippedAt = now;
  } else if (from === "done") {
    const shipped = includedIds.length
      ? await tx
          .update(tasks)
          .set({ shippedAt: null, updatedAt: now })
          .where(
            and(
              inArray(tasks.id, includedIds),
              eq(tasks.releaseId, release.id),
              isNotNull(tasks.shippedAt),
              isNull(tasks.deletedAt),
            ),
          )
          .returning({
            id: tasks.id,
            number: tasks.number,
            projectId: tasks.projectId,
          })
      : [];
    for (const task of await withProjectKeys(tx, shipped)) {
      await recordActivity(tx, ctx, {
        entityType: "task",
        entityId: task.id,
        action: "task.unshipped",
        changes: shippedIn,
      });
      await announce(tx, ctx, task);
    }
    shippedAt = null;
  }

  if (to === "canceled" && includedIds.length > 0) {
    const freed = await tx
      .update(tasks)
      .set({ releaseId: null, updatedAt: now })
      .where(
        and(
          inArray(tasks.id, includedIds),
          eq(tasks.releaseId, release.id),
          isNull(tasks.deletedAt),
        ),
      )
      .returning({
        id: tasks.id,
        number: tasks.number,
        projectId: tasks.projectId,
      });
    for (const task of await withProjectKeys(tx, freed)) {
      await recordActivity(tx, ctx, {
        entityType: "task",
        entityId: task.id,
        action: "task.updated",
        changes: { releaseId: [release.id, null] },
      });
      await announce(tx, ctx, task);
    }
  }
  return shippedAt;
}

async function withProjectKeys<T extends { projectId: string }>(
  tx: Tx,
  rows: T[],
): Promise<(T & { projectKey: string })[]> {
  if (rows.length === 0) return [];
  const keys = await tx
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(inArray(projects.id, [...new Set(rows.map((r) => r.projectId))]));
  const keyOf = new Map(keys.map((p) => [p.id, p.key]));
  return rows.map((r) => ({ ...r, projectKey: keyOf.get(r.projectId) ?? "" }));
}

/**
 * A deleted release lets go of its tasks (shipped ones keep `shippedAt`); refused when one is
 * outside the actor's `scope`.
 */
export async function releaseTasksOnDelete(
  tx: Tx,
  ctx: ActorContext,
  scope: ProjectScope,
  release: { id: string; key: string },
) {
  assertSeesWholeRelease(
    scope,
    release.key,
    await allReleaseTasks(tx, release.id),
    "delete it",
  );
  const releaseId = release.id;
  const now = new Date();
  const freed = await tx
    .update(tasks)
    .set({ releaseId: null, updatedAt: now })
    .where(and(eq(tasks.releaseId, releaseId), ne(tasks.id, releaseId)))
    .returning({
      id: tasks.id,
      number: tasks.number,
      projectId: tasks.projectId,
      deletedAt: tasks.deletedAt,
    });
  for (const task of await withProjectKeys(tx, freed)) {
    if (task.deletedAt) continue;
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: task.id,
      action: "task.updated",
      changes: { releaseId: [releaseId, null] },
    });
    await announce(tx, ctx, task);
  }
}
