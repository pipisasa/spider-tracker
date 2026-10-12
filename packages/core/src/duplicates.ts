import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { assertCanWrite, type ActorContext } from "./access";
import { postComment } from "./comments";
import type { TaskDto } from "./contracts";
import { DomainError } from "./errors";
import { linkTasks, lockPair } from "./relations";
import { markDuplicateInput } from "./schemas";
import { applyTaskUpdate, findTask } from "./tasks";
import { parseInput } from "./validate";

// Marking a duplicate in one step (ST-114): the `duplicates` link, the first canceled status of the
// task's workflow (its project and kind, ST-90) and a comment naming the original, in one transaction.

const { projects, statuses, taskRelations, tasks } = schema;

/**
 * Marks `taskKey` as a duplicate of `input.of`: links it (`duplicates`), moves it to the first status of
 * category `canceled` in its project's workflow for its kind (unless it already is in a canceled one) and comments "Duplicate of KEY".
 * Idempotent: when the link and a canceled status are already there, nothing changes (no comment either).
 * Refused: a task as its own duplicate, a cycle of duplicates, a task already marked as a duplicate of
 * another task, and a project without a canceled status. The original may be in any status, even closed
 * or a duplicate itself (chains are allowed, cycles aren't).
 */
export async function markDuplicate(db: Db, ctx: ActorContext, taskKey: string, input: unknown): Promise<TaskDto> {
  assertCanWrite(ctx);
  const data = parseInput(markDuplicateInput, input);
  return db.transaction(async (tx) => {
    const first = await findTask(tx, ctx, taskKey);
    const original = await findTask(tx, ctx, data.of);
    if (first.task.id === original.task.id) throw new DomainError("validation", "A task can't be a duplicate of itself");
    // One mark at a time per task (against another original too); "no key update" leaves link inserts alone.
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, first.task.id)).for("no key update");
    await lockPair(tx, first.task.id, original.task.id);
    const self = await findTask(tx, ctx, taskKey);
    const originalKey = `${original.projectKey}-${original.task.number}`;

    const marked = await tx
      .select({ id: tasks.id, number: tasks.number, projectKey: projects.key })
      .from(taskRelations)
      .innerJoin(tasks, eq(tasks.id, taskRelations.toTaskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(taskRelations.fromTaskId, self.task.id), eq(taskRelations.type, "duplicates"), isNull(tasks.deletedAt)));
    const linked = marked.some((m) => m.id === original.task.id);
    const elsewhere = marked.find((m) => m.id !== original.task.id);
    if (!linked && elsewhere) {
      throw new DomainError(
        "conflict",
        `${self.projectKey}-${self.task.number} is already a duplicate of ${elsewhere.projectKey}-${elsewhere.number}; unlink that first`,
      );
    }

    const [current] = await tx.select({ category: statuses.category }).from(statuses).where(eq(statuses.id, self.task.statusId)).limit(1);
    let statusId: string | undefined;
    if (current?.category !== "canceled") {
      const [canceled] = await tx
        .select({ id: statuses.id })
        .from(statuses)
        .where(
          and(eq(statuses.projectId, self.task.projectId), eq(statuses.kind, self.task.kind), eq(statuses.category, "canceled")),
        )
        .orderBy(asc(statuses.position))
        .limit(1);
      if (!canceled) {
        const where = self.task.kind === "task" ? `Project ${self.projectKey}` : `${self.projectKey}'s ${self.task.kind} workflow`;
        throw new DomainError("validation", `${where} has no canceled status to move the duplicate to`);
      }
      statusId = canceled.id;
    }

    if (!linked) await linkTasks(tx, ctx, self, original, "duplicates");
    const { task } = await applyTaskUpdate(tx, ctx, self, statusId ? { statusId } : {});
    if (!linked || statusId) {
      const note = `Duplicate of ${originalKey}: ${original.task.title}`;
      await postComment(tx, ctx, self, { body: data.comment ? `${note}\n\n${data.comment}` : note });
    }
    return task;
  });
}
