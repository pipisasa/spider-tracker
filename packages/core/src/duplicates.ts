import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { assertCanWrite, type ActorContext } from "./access";
import { postComment } from "./comments";
import type { TaskDto } from "./contracts";
import { DomainError } from "./errors";
import { linkTasks, lockDuplicate, lockPair } from "./relations";
import { markDuplicateInput } from "./schemas";
import { applyTaskUpdate, findTask } from "./tasks";
import { parseInput } from "./validate";

// Marking a duplicate in one step (ST-114): the `duplicates` link, the first canceled status of the
// task's workflow (its project and kind, ST-90) and a comment naming the original, in one transaction.

const { comments, statuses, taskRelations } = schema;

/**
 * Marks `taskKey` as a duplicate of `input.of`: links it (`duplicates`), moves it to the first status of
 * category `canceled` in its project's workflow for its kind (unless it already is in a canceled one) and comments "Duplicate of KEY".
 * Idempotent: when the link and a canceled status are already there, nothing changes, except that a
 * `comment` given again is posted by itself (skipped when it repeats the caller's latest comment). Refused: a task as its own duplicate, a cycle of duplicates,
 * a task already marked as a duplicate of another task (409; linkTasks refuses it for plain links too),
 * and a project without a canceled status. The original may be in any status, even closed
 * or a duplicate itself (chains are allowed, cycles aren't).
 */
export async function markDuplicate(
  db: Db,
  ctx: ActorContext,
  taskKey: string,
  input: unknown,
): Promise<TaskDto> {
  assertCanWrite(ctx);
  const data = parseInput(markDuplicateInput, input);
  return db.transaction(async (tx) => {
    const first = await findTask(tx, ctx, taskKey);
    const original = await findTask(tx, ctx, data.of);
    if (first.task.id === original.task.id)
      throw new DomainError(
        "validation",
        "A task can't be a duplicate of itself",
      );
    // One mark at a time per task (against another original too).
    await lockDuplicate(tx, first.task.id);
    await lockPair(tx, first.task.id, original.task.id);
    const self = await findTask(tx, ctx, taskKey);
    const originalKey = `${original.projectKey}-${original.task.number}`;

    const [existing] = await tx
      .select({ id: taskRelations.toTaskId })
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.fromTaskId, self.task.id),
          eq(taskRelations.toTaskId, original.task.id),
          eq(taskRelations.type, "duplicates"),
        ),
      )
      .limit(1);
    const linked = existing !== undefined;

    const [current] = await tx
      .select({ category: statuses.category })
      .from(statuses)
      .where(eq(statuses.id, self.task.statusId))
      .limit(1);
    let statusId: string | undefined;
    if (current?.category !== "canceled") {
      const [canceled] = await tx
        .select({ id: statuses.id })
        .from(statuses)
        .where(
          and(
            eq(statuses.projectId, self.task.projectId),
            eq(statuses.kind, self.task.kind),
            eq(statuses.category, "canceled"),
          ),
        )
        .orderBy(asc(statuses.position))
        .limit(1);
      if (!canceled) {
        const where =
          self.task.kind === "task"
            ? `Project ${self.projectKey}`
            : `${self.projectKey}'s ${self.task.kind} workflow`;
        throw new DomainError(
          "validation",
          `${where} has no canceled status to move the duplicate to`,
        );
      }
      statusId = canceled.id;
    }

    // linkTasks refuses a second original (a duplicate of another task) and cycles.
    if (!linked) await linkTasks(tx, ctx, self, original, "duplicates");
    const { task } = await applyTaskUpdate(
      tx,
      ctx,
      self,
      statusId ? { statusId } : {},
    );
    const note = `Duplicate of ${originalKey}: ${original.task.title}`;
    if (!linked || statusId) {
      await postComment(tx, ctx, self, {
        body: data.comment ? `${note}\n\n${data.comment}` : note,
      });
    } else if (data.comment) {
      // Already marked: the new comment is posted by itself rather than dropped (ST-131), unless the
      // caller's latest comment on the task already says it, as after a retried call (ST-147).
      const [latest] = await tx
        .select({ body: comments.body })
        .from(comments)
        .where(
          and(
            eq(comments.taskId, self.task.id),
            eq(comments.authorId, ctx.actorId),
            isNull(comments.deletedAt),
          ),
        )
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .limit(1);
      const repeated =
        latest?.body === data.comment ||
        latest?.body === `${note}\n\n${data.comment}`;
      if (!repeated) await postComment(tx, ctx, self, { body: data.comment });
    }
    return task;
  });
}
