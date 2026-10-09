import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, or } from "drizzle-orm";
import { assertCanWrite, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { RelationDto, RelationKind } from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import { relationInput } from "./schemas";
import { findTask } from "./tasks";
import { parseInput } from "./validate";

// Task relations (ST-10). One row per link, stored as "from <type> to"; each side sees it
// from its own point of view (blocks / blocked_by, duplicates / duplicated_by, relates).

const { projects, taskRelations, tasks } = schema;

type StoredType = "blocks" | "relates" | "duplicates";

/** Normalises a kind seen from `self` into the stored direction. */
function toStored(kind: RelationKind, self: string, other: string): { from: string; to: string; type: StoredType } {
  if (kind === "blocked_by") return { from: other, to: self, type: "blocks" };
  if (kind === "duplicated_by") return { from: other, to: self, type: "duplicates" };
  return { from: self, to: other, type: kind };
}

async function findLink(tx: Tx, from: string, to: string, type: StoredType) {
  const symmetric = type === "relates";
  const [row] = await tx
    .select({ fromTaskId: taskRelations.fromTaskId, toTaskId: taskRelations.toTaskId })
    .from(taskRelations)
    .where(
      and(
        eq(taskRelations.type, type),
        symmetric
          ? or(
              and(eq(taskRelations.fromTaskId, from), eq(taskRelations.toTaskId, to)),
              and(eq(taskRelations.fromTaskId, to), eq(taskRelations.toTaskId, from)),
            )
          : and(eq(taskRelations.fromTaskId, from), eq(taskRelations.toTaskId, to)),
      ),
    )
    .limit(1);
  return row;
}

async function announce(tx: Tx, ctx: ActorContext, ...keys: { key: string; projectKey: string }[]) {
  for (const { key, projectKey } of keys) await publish(tx, { type: "task.changed", orgId: ctx.orgId, projectKey, taskKey: key });
}

export async function addRelation(db: Db, ctx: ActorContext, taskKey: string, input: unknown): Promise<RelationDto> {
  assertCanWrite(ctx);
  const { kind, task: otherKey } = parseInput(relationInput, input);
  return db.transaction(async (tx) => {
    const self = await findTask(tx, ctx.orgId, taskKey);
    const other = await findTask(tx, ctx.orgId, otherKey);
    if (self.task.id === other.task.id) throw new DomainError("validation", "A task can't be related to itself");

    const link = toStored(kind, self.task.id, other.task.id);
    if (await findLink(tx, link.from, link.to, link.type)) throw new DomainError("conflict", "These tasks are already linked that way");
    // "A blocks B" and "B blocks A" together would be a deadlock.
    if (link.type === "blocks" && (await findLink(tx, link.to, link.from, "blocks"))) {
      throw new DomainError("validation", "The other task already blocks this one; two tasks can't block each other");
    }
    await tx.insert(taskRelations).values({ fromTaskId: link.from, toTaskId: link.to, type: link.type, createdBy: ctx.actorId });

    const selfKey = `${self.projectKey}-${self.task.number}`;
    const otherFullKey = `${other.projectKey}-${other.task.number}`;
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: self.task.id,
      action: "relation.added",
      changes: { kind, task: otherFullKey },
    });
    await announce(tx, ctx, { key: selfKey, projectKey: self.projectKey }, { key: otherFullKey, projectKey: other.projectKey });
    return {
      kind,
      task: { id: other.task.id, key: otherFullKey, title: other.task.title, statusId: other.task.statusId },
    };
  });
}

export async function removeRelation(db: Db, ctx: ActorContext, taskKey: string, input: unknown) {
  assertCanWrite(ctx);
  const { kind, task: otherKey } = parseInput(relationInput, input);
  await db.transaction(async (tx) => {
    const self = await findTask(tx, ctx.orgId, taskKey);
    const other = await findTask(tx, ctx.orgId, otherKey);
    const link = toStored(kind, self.task.id, other.task.id);
    const found = await findLink(tx, link.from, link.to, link.type);
    if (!found) throw new DomainError("not_found", "No such link between these tasks");
    await tx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.fromTaskId, found.fromTaskId),
          eq(taskRelations.toTaskId, found.toTaskId),
          eq(taskRelations.type, link.type),
        ),
      );
    const otherFullKey = `${other.projectKey}-${other.task.number}`;
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: self.task.id,
      action: "relation.removed",
      changes: { kind, task: otherFullKey },
    });
    await announce(
      tx,
      ctx,
      { key: `${self.projectKey}-${self.task.number}`, projectKey: self.projectKey },
      { key: otherFullKey, projectKey: other.projectKey },
    );
  });
}

/** Every link of a task, from its point of view, ordered by kind then key. */
export async function listRelations(db: Db, orgId: string, taskKey: string): Promise<RelationDto[]> {
  const { task } = await findTask(db, orgId, taskKey);
  const rows = await db
    .select({
      fromTaskId: taskRelations.fromTaskId,
      toTaskId: taskRelations.toTaskId,
      type: taskRelations.type,
      other: { id: tasks.id, number: tasks.number, title: tasks.title, statusId: tasks.statusId, deletedAt: tasks.deletedAt },
      projectKey: projects.key,
    })
    .from(taskRelations)
    .innerJoin(
      tasks,
      or(
        and(eq(taskRelations.fromTaskId, task.id), eq(tasks.id, taskRelations.toTaskId)),
        and(eq(taskRelations.toTaskId, task.id), eq(tasks.id, taskRelations.fromTaskId)),
      ),
    )
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(or(eq(taskRelations.fromTaskId, task.id), eq(taskRelations.toTaskId, task.id)));

  const order: RelationKind[] = ["blocked_by", "blocks", "duplicates", "duplicated_by", "relates"];
  return rows
    .filter((r) => !r.other.deletedAt)
    .map((r) => {
      const outgoing = r.fromTaskId === task.id;
      const kind: RelationKind =
        r.type === "relates" ? "relates" : r.type === "blocks" ? (outgoing ? "blocks" : "blocked_by") : outgoing ? "duplicates" : "duplicated_by";
      return {
        kind,
        task: { id: r.other.id, key: `${r.projectKey}-${r.other.number}`, title: r.other.title, statusId: r.other.statusId },
      };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.task.key.localeCompare(b.task.key, undefined, { numeric: true }));
}
