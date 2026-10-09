import type { Tx } from "@repo/db";
import { schema } from "@repo/db";
import type { ActorContext } from "./access";

export async function recordActivity(
  tx: Tx,
  ctx: ActorContext,
  entry: { entityType: string; entityId: string; action: string; changes?: Record<string, unknown> },
) {
  await tx.insert(schema.activity).values({
    orgId: ctx.orgId,
    actorId: ctx.actorId,
    source: ctx.source,
    ...entry,
  });
}
