import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  assertCanWrite,
  inScope,
  projectScope,
  type ActorContext,
  type Viewer,
} from "./access";
import { recordActivity } from "./activity";
import type { RelationDto, RelationKind } from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import { relationInput } from "./schemas";
import { findTask, type FoundTask } from "./tasks";
import { parseInput } from "./validate";

// Task relations (ST-10). One row per link, stored as "from <type> to"; each side sees it
// from its own point of view (blocks / blocked_by, duplicates / duplicated_by, relates).

const { projects, taskRelations, tasks } = schema;

type StoredType = "blocks" | "relates" | "duplicates";

/** Normalises a kind seen from `self` into the stored direction; `relates` is stored smaller id first. */
function toStored(
  kind: RelationKind,
  self: string,
  other: string,
): { from: string; to: string; type: StoredType } {
  if (kind === "blocked_by") return { from: other, to: self, type: "blocks" };
  if (kind === "duplicated_by")
    return { from: other, to: self, type: "duplicates" };
  if (kind === "relates") {
    // Must agree with the `task_relations_relates_ordered` CHECK (from < to as uuids): Postgres
    // orders uuids by bytes, which matches comparing their lowercase hex strings.
    return self.toLowerCase() < other.toLowerCase()
      ? { from: self, to: other, type: kind }
      : { from: other, to: self, type: kind };
  }
  return { from: self, to: other, type: kind };
}

/** Serialises link changes between two tasks, so checks like "the other already blocks this one" see concurrent inserts. */
export async function lockPair(tx: Tx, a: string, b: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('relation:' || least(${a}::uuid, ${b}::uuid)::text || ':' || greatest(${a}::uuid, ${b}::uuid)::text))`,
  );
}

/**
 * Locks the task about to become a duplicate, so it gets one original at a time: two concurrent
 * marks or links against different originals (different pairs) would otherwise both pass the
 * "already a duplicate" check (ST-131). Take it before lockPair; "no key update" leaves link
 * inserts that reference the task alone.
 */
export async function lockDuplicate(tx: Tx, taskId: string) {
  await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("no key update");
}

/**
 * Refuses a second original: `duplicateId` already duplicates a live task other than `originalId`.
 * The message names that original only when the caller can see its project (ST-131).
 */
async function assertSingleOriginal(
  tx: Tx,
  ctx: ActorContext,
  duplicateId: string,
  duplicateKey: string,
  originalId: string,
) {
  const [elsewhere] = await tx
    .select({
      number: tasks.number,
      projectId: tasks.projectId,
      projectKey: projects.key,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(tasks.id, taskRelations.toTaskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        eq(taskRelations.fromTaskId, duplicateId),
        eq(taskRelations.type, "duplicates"),
        ne(taskRelations.toTaskId, originalId),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1);
  if (!elsewhere) return;
  const visible = inScope(await projectScope(tx, ctx), elsewhere.projectId);
  throw new DomainError(
    "conflict",
    visible
      ? `${duplicateKey} is already a duplicate of ${elsewhere.projectKey}-${elsewhere.number}; unlink that first`
      : `${duplicateKey} is already a duplicate of a task in a project you can't see; ask a member to unlink it`,
  );
}

const INVERSE: Record<RelationKind, RelationKind> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  duplicates: "duplicated_by",
  duplicated_by: "duplicates",
  relates: "relates",
};

async function findLink(tx: Tx, from: string, to: string, type: StoredType) {
  const symmetric = type === "relates";
  const [row] = await tx
    .select({
      fromTaskId: taskRelations.fromTaskId,
      toTaskId: taskRelations.toTaskId,
    })
    .from(taskRelations)
    .where(
      and(
        eq(taskRelations.type, type),
        symmetric
          ? or(
              and(
                eq(taskRelations.fromTaskId, from),
                eq(taskRelations.toTaskId, to),
              ),
              and(
                eq(taskRelations.fromTaskId, to),
                eq(taskRelations.toTaskId, from),
              ),
            )
          : and(
              eq(taskRelations.fromTaskId, from),
              eq(taskRelations.toTaskId, to),
            ),
      ),
    )
    .limit(1);
  return row;
}

async function announce(
  tx: Tx,
  ctx: ActorContext,
  ...keys: { key: string; projectKey: string }[]
) {
  for (const { key, projectKey } of keys)
    await publish(tx, {
      type: "task.changed",
      orgId: ctx.orgId,
      projectKey,
      taskKey: key,
    });
}

export async function addRelation(
  db: Db,
  ctx: ActorContext,
  taskKey: string,
  input: unknown,
): Promise<RelationDto> {
  assertCanWrite(ctx);
  const { kind, task: otherKey } = parseInput(relationInput, input);
  return db.transaction(async (tx) => {
    const self = await findTask(tx, ctx, taskKey);
    const other = await findTask(tx, ctx, otherKey);
    if (self.task.id === other.task.id)
      throw new DomainError("validation", "A task can't be related to itself");
    if (kind === "duplicates") await lockDuplicate(tx, self.task.id);
    if (kind === "duplicated_by") await lockDuplicate(tx, other.task.id);
    await lockPair(tx, self.task.id, other.task.id);
    return linkTasks(tx, ctx, self, other, kind);
  });
}

/**
 * Whether `from` already duplicates `to`, directly or through a chain of `duplicates` links
 * (deleted tasks break the chain). Linking `to` as a duplicate of `from` would close a cycle.
 */
export async function duplicatesChain(
  tx: Tx,
  from: string,
  to: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    with recursive chain(id) as (
      select to_task_id from task_relations where from_task_id = ${from}::uuid and type = 'duplicates'
      union
      select r.to_task_id from task_relations r
      join chain c on r.from_task_id = c.id
      join tasks t on t.id = c.id and t.deleted_at is null
      where r.type = 'duplicates'
    )
    select 1 from chain where id = ${to}::uuid limit 1
  `);
  return rows.length > 0;
}

/**
 * The body of addRelation for two different tasks found in `tx` whose pair is locked (lockPair), and
 * for a duplicate link whose duplicate is locked too (lockDuplicate): refuses an existing link, mutual
 * blocking, duplicate cycles and a second original, then records and announces it.
 */
export async function linkTasks(
  tx: Tx,
  ctx: ActorContext,
  self: FoundTask,
  other: FoundTask,
  kind: RelationKind,
): Promise<RelationDto> {
  const link = toStored(kind, self.task.id, other.task.id);
  if (await findLink(tx, link.from, link.to, link.type))
    throw new DomainError(
      "conflict",
      "These tasks are already linked that way",
    );
  // "A blocks B" and "B blocks A" together would be a deadlock.
  if (
    link.type === "blocks" &&
    (await findLink(tx, link.to, link.from, "blocks"))
  ) {
    throw new DomainError(
      "validation",
      "The other task already blocks this one; two tasks can't block each other",
    );
  }
  // "A duplicates B" when B already duplicates A (directly or through other tasks) would be a cycle.
  if (
    link.type === "duplicates" &&
    (await duplicatesChain(tx, link.to, link.from))
  ) {
    throw new DomainError(
      "validation",
      "That would make a cycle of duplicates: the original is already a duplicate of this task",
    );
  }
  // A task duplicates one original; another one needs that link removed first.
  if (link.type === "duplicates") {
    const duplicate = kind === "duplicates" ? self : other;
    await assertSingleOriginal(
      tx,
      ctx,
      link.from,
      `${duplicate.projectKey}-${duplicate.task.number}`,
      link.to,
    );
  }
  const [inserted] = await tx
    .insert(taskRelations)
    .values({
      fromTaskId: link.from,
      toTaskId: link.to,
      type: link.type,
      createdBy: ctx.actorId,
    })
    .onConflictDoNothing()
    .returning({ fromTaskId: taskRelations.fromTaskId });
  // A concurrent request added the same link.
  if (!inserted)
    throw new DomainError(
      "conflict",
      "These tasks are already linked that way",
    );

  const selfKey = `${self.projectKey}-${self.task.number}`;
  const otherFullKey = `${other.projectKey}-${other.task.number}`;
  await recordActivity(tx, ctx, {
    entityType: "task",
    entityId: self.task.id,
    action: "relation.added",
    changes: { kind, task: otherFullKey },
  });
  await recordActivity(tx, ctx, {
    entityType: "task",
    entityId: other.task.id,
    action: "relation.added",
    changes: { kind: INVERSE[kind], task: selfKey },
  });
  await announce(
    tx,
    ctx,
    { key: selfKey, projectKey: self.projectKey },
    { key: otherFullKey, projectKey: other.projectKey },
  );
  return {
    kind,
    task: {
      id: other.task.id,
      key: otherFullKey,
      title: other.task.title,
      statusId: other.task.statusId,
    },
  };
}

export async function removeRelation(
  db: Db,
  ctx: ActorContext,
  taskKey: string,
  input: unknown,
) {
  assertCanWrite(ctx);
  const { kind, task: otherKey } = parseInput(relationInput, input);
  await db.transaction(async (tx) => {
    const self = await findTask(tx, ctx, taskKey);
    const other = await findTask(tx, ctx, otherKey);
    const link = toStored(kind, self.task.id, other.task.id);
    const found = await findLink(tx, link.from, link.to, link.type);
    if (!found)
      throw new DomainError("not_found", "No such link between these tasks");
    const deleted = await tx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.fromTaskId, found.fromTaskId),
          eq(taskRelations.toTaskId, found.toTaskId),
          eq(taskRelations.type, link.type),
        ),
      )
      .returning({ fromTaskId: taskRelations.fromTaskId });
    // A concurrent request removed it first.
    if (deleted.length === 0)
      throw new DomainError("not_found", "No such link between these tasks");
    const selfKey = `${self.projectKey}-${self.task.number}`;
    const otherFullKey = `${other.projectKey}-${other.task.number}`;
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: self.task.id,
      action: "relation.removed",
      changes: { kind, task: otherFullKey },
    });
    await recordActivity(tx, ctx, {
      entityType: "task",
      entityId: other.task.id,
      action: "relation.removed",
      changes: { kind: INVERSE[kind], task: selfKey },
    });
    await announce(
      tx,
      ctx,
      { key: selfKey, projectKey: self.projectKey },
      { key: otherFullKey, projectKey: other.projectKey },
    );
  });
}

/** Every link of a task, from its point of view, ordered by kind then key. */
export async function listRelations(
  db: Db,
  viewer: Viewer,
  taskKey: string,
): Promise<RelationDto[]> {
  const { task } = await findTask(db, viewer, taskKey);
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select({
      fromTaskId: taskRelations.fromTaskId,
      toTaskId: taskRelations.toTaskId,
      type: taskRelations.type,
      other: {
        id: tasks.id,
        projectId: tasks.projectId,
        number: tasks.number,
        title: tasks.title,
        statusId: tasks.statusId,
        deletedAt: tasks.deletedAt,
      },
      projectKey: projects.key,
    })
    .from(taskRelations)
    .innerJoin(
      tasks,
      or(
        and(
          eq(taskRelations.fromTaskId, task.id),
          eq(tasks.id, taskRelations.toTaskId),
        ),
        and(
          eq(taskRelations.toTaskId, task.id),
          eq(tasks.id, taskRelations.fromTaskId),
        ),
      ),
    )
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      or(
        eq(taskRelations.fromTaskId, task.id),
        eq(taskRelations.toTaskId, task.id),
      ),
    );

  const order: RelationKind[] = [
    "blocked_by",
    "blocks",
    "duplicates",
    "duplicated_by",
    "relates",
  ];
  return rows
    .filter((r) => !r.other.deletedAt && inScope(scope, r.other.projectId))
    .map((r) => {
      const outgoing = r.fromTaskId === task.id;
      const kind: RelationKind =
        r.type === "relates"
          ? "relates"
          : r.type === "blocks"
            ? outgoing
              ? "blocks"
              : "blocked_by"
            : outgoing
              ? "duplicates"
              : "duplicated_by";
      return {
        kind,
        task: {
          id: r.other.id,
          key: `${r.projectKey}-${r.other.number}`,
          title: r.other.title,
          statusId: r.other.statusId,
        },
      };
    })
    .sort(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        a.task.key.localeCompare(b.task.key, undefined, { numeric: true }),
    );
}
