import type { Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { StatusCategory } from "./contracts";
import { appsNotInProduction } from "./deployment-records";
import { DomainError } from "./errors";
import { publish } from "./events";
import { effectiveMilestones, settleMilestones } from "./milestone-membership";

// Shipping (ST-93): what a release's status does to the Done tasks it includes. Done means
// finished; a task has shipped once its release is Released (category done). Status changes of
// the tasks themselves are untouched: they are already Done.

const { projects, statuses, tasks } = schema;

interface ReleaseRow {
  id: string;
  key: string;
  title: string;
}

/** The release's live tasks with their project keys, oldest key first. */
const includedTasks = (tx: Tx, releaseId: string) =>
  tx
    .select({ id: tasks.id, number: tasks.number, projectKey: projects.key, category: statuses.category, shippedAt: tasks.shippedAt })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(statuses, eq(statuses.id, tasks.statusId))
    .where(and(eq(tasks.releaseId, releaseId), isNull(tasks.deletedAt)))
    .orderBy(asc(projects.key), asc(tasks.number));

async function announce(tx: Tx, ctx: ActorContext, task: { number: number; projectKey: string }) {
  await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey: task.projectKey, taskKey: `${task.projectKey}-${task.number}` });
}

/**
 * Runs when a release's status changes category, inside the update's transaction:
 * - into done (Released): every included task must be Done, and every app of the release that has
 *   environments must be deployed (by this release) to its last one, its production (ST-94); the
 *   tasks get `shippedAt` (the release time) and a "task.shipped" activity entry, "shipped in <version>";
 * - out of done: the shipping is undone ("task.unshipped");
 * - into canceled: the included tasks leave the release, free for another one.
 * Returns the release's own `shippedAt` when it changes (undefined when it doesn't).
 */
export async function applyReleaseTransition(
  tx: Tx,
  ctx: ActorContext,
  release: ReleaseRow,
  from: StatusCategory,
  to: StatusCategory,
  now: Date,
): Promise<Date | null | undefined> {
  if (from === to) return undefined;
  const version = { release: release.key, version: release.title };
  let shippedAt: Date | null | undefined;

  if (to === "done") {
    const included = await includedTasks(tx, release.id);
    const unfinished = included.filter((t) => t.category !== "done");
    if (unfinished.length > 0) {
      throw new DomainError(
        "validation",
        `Release ${release.key} can't be released: ${unfinished.map((t) => `${t.projectKey}-${t.number}`).join(", ")} ${unfinished.length === 1 ? "isn't" : "aren't"} Done. Finish or remove ${unfinished.length === 1 ? "it" : "them"} first`,
      );
    }
    // Released follows deployments (ST-94): allowed once every app is in production, never automatic.
    const pending = await appsNotInProduction(tx, release.id);
    if (pending.length > 0) {
      const names = pending.map((a) => `${a.name} to ${a.production}`).join(", ");
      const [first] = pending;
      throw new DomainError(
        "validation",
        `Release ${release.key} can't be released: it isn't deployed ${names} yet. Record each deploy first (spider release deploy ${release.key} --app ${first?.name} --env ${first?.production})`,
      );
    }
    const shipping = included.filter((t) => !t.shippedAt);
    for (const task of shipping) {
      await tx.update(tasks).set({ shippedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
      await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.shipped", changes: version });
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
    const shipped = await tx
      .update(tasks)
      .set({ shippedAt: null, updatedAt: now })
      .where(and(eq(tasks.releaseId, release.id), isNotNull(tasks.shippedAt), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id, number: tasks.number, projectId: tasks.projectId });
    for (const task of await withProjectKeys(tx, shipped)) {
      await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.unshipped", changes: version });
      await announce(tx, ctx, task);
    }
    shippedAt = null;
  }

  if (to === "canceled") {
    const freed = await tx
      .update(tasks)
      .set({ releaseId: null, updatedAt: now })
      .where(and(eq(tasks.releaseId, release.id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id, number: tasks.number, projectId: tasks.projectId });
    for (const task of await withProjectKeys(tx, freed)) {
      await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.updated", changes: { releaseId: [release.id, null] } });
      await announce(tx, ctx, task);
    }
  }
  return shippedAt;
}

async function withProjectKeys<T extends { projectId: string }>(tx: Tx, rows: T[]): Promise<(T & { projectKey: string })[]> {
  if (rows.length === 0) return [];
  const keys = await tx
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(inArray(projects.id, [...new Set(rows.map((r) => r.projectId))]));
  const keyOf = new Map(keys.map((p) => [p.id, p.key]));
  return rows.map((r) => ({ ...r, projectKey: keyOf.get(r.projectId) ?? "" }));
}

/** A deleted release lets go of its tasks (shipped ones keep `shippedAt`). */
export async function releaseTasksOnDelete(tx: Tx, ctx: ActorContext, releaseId: string) {
  const now = new Date();
  const freed = await tx
    .update(tasks)
    .set({ releaseId: null, updatedAt: now })
    .where(and(eq(tasks.releaseId, releaseId), ne(tasks.id, releaseId)))
    .returning({ id: tasks.id, number: tasks.number, projectId: tasks.projectId, deletedAt: tasks.deletedAt });
  for (const task of await withProjectKeys(tx, freed)) {
    if (task.deletedAt) continue;
    await recordActivity(tx, ctx, { entityType: "task", entityId: task.id, action: "task.updated", changes: { releaseId: [releaseId, null] } });
    await announce(tx, ctx, task);
  }
}
