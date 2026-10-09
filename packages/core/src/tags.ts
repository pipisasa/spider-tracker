import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq } from "drizzle-orm";
import { assertCanWrite, assertRole, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { TagDto } from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import { createTagInput } from "./schemas";
import { parseInput } from "./validate";

// Organization-wide tags (ST-8). Anyone who can edit tasks can create tags; owners and
// admins delete them (removing them from every task).

const { tags } = schema;

const toTagDto = (row: typeof tags.$inferSelect): TagDto => ({ id: row.id, name: row.name, color: row.color });

export async function listTags(db: Db, orgId: string): Promise<TagDto[]> {
  const rows = await db.select().from(tags).where(eq(tags.orgId, orgId)).orderBy(asc(tags.name));
  return rows.map(toTagDto);
}

export async function createTag(db: Db, ctx: ActorContext, input: unknown): Promise<TagDto> {
  assertCanWrite(ctx);
  const { name, color } = parseInput(createTagInput, input);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tags)
      .values({ orgId: ctx.orgId, name, color: color ?? null })
      .onConflictDoNothing({ target: [tags.orgId, tags.name] })
      .returning();
    if (!row) throw new DomainError("conflict", `Tag "${name}" already exists`);
    await recordActivity(tx, ctx, { entityType: "tag", entityId: row.id, action: "tag.created", changes: { name } });
    await publish(tx, { type: "tags.changed", orgId: ctx.orgId });
    return toTagDto(row);
  });
}

export async function deleteTag(db: Db, ctx: ActorContext, tagId: string) {
  assertRole(ctx, ["owner", "admin"], "delete tags");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.orgId, ctx.orgId)))
      .returning();
    if (!row) throw new DomainError("not_found", "Tag not found");
    await recordActivity(tx, ctx, { entityType: "tag", entityId: row.id, action: "tag.deleted", changes: { name: row.name } });
    await publish(tx, { type: "tags.changed", orgId: ctx.orgId });
  });
}
