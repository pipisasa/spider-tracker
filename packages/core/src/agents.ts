import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { assertRole, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { ApiKeyDto, CreatedApiKeyDto } from "./contracts";
import { DomainError } from "./errors";
import { handleFrom } from "./handles";
import { createAgentInput, createApiKeyInput } from "./schemas";
import { parseInput } from "./validate";

const { actors, agents, apiTokens, organizations } = schema;

const KEY_PREFIX = "spt_";

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function toApiKeyDto(row: typeof apiTokens.$inferSelect): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** Creates an external agent member owned by the acting person. */
export async function createAgent(db: Db, ctx: ActorContext, input: unknown) {
  assertRole(ctx, ["owner", "admin"], "create agents");
  const data = parseInput(createAgentInput, input);
  const handle = data.handle ?? handleFrom(data.name);

  return db.transaction(async (tx) => {
    const [actor] = await tx
      .insert(actors)
      .values({ orgId: ctx.orgId, type: "agent", name: data.name, handle, role: "member" })
      .onConflictDoNothing({ target: [actors.orgId, actors.handle] })
      .returning();
    if (!actor) throw new DomainError("conflict", `Handle @${handle} is already used`);

    await tx.insert(agents).values({ actorId: actor.id, ownerId: ctx.actorId, description: data.description ?? null });
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: actor.id,
      action: "agent.created",
      changes: { name: data.name, handle },
    });
    return { actor, ownerId: ctx.actorId, description: data.description ?? null, keys: [] as ApiKeyDto[] };
  });
}

export async function listAgents(db: Db, orgId: string) {
  const rows = await db
    .select({ actor: actors, agent: agents })
    .from(agents)
    .innerJoin(actors, eq(agents.actorId, actors.id))
    .where(and(eq(actors.orgId, orgId), isNull(actors.deactivatedAt)))
    .orderBy(asc(actors.name));
  const ids = rows.map((r) => r.actor.id);
  const keys =
    ids.length === 0
      ? []
      : await db.select().from(apiTokens).where(inArray(apiTokens.actorId, ids)).orderBy(asc(apiTokens.createdAt));
  return rows.map(({ actor, agent }) => ({
    actor,
    ownerId: agent.ownerId,
    description: agent.description,
    keys: keys.filter((k) => k.actorId === actor.id).map(toApiKeyDto),
  }));
}

async function findAgent(db: Db, orgId: string, agentActorId: string) {
  const [row] = await db
    .select({ id: actors.id })
    .from(agents)
    .innerJoin(actors, eq(agents.actorId, actors.id))
    .where(and(eq(actors.id, agentActorId), eq(actors.orgId, orgId), isNull(actors.deactivatedAt)))
    .limit(1);
  if (!row) throw new DomainError("not_found", "Agent not found");
  return row;
}

/** Issues a new API key for an agent. The secret is returned only here. */
export async function createApiKey(
  db: Db,
  ctx: ActorContext,
  agentActorId: string,
  input: unknown,
): Promise<CreatedApiKeyDto> {
  assertRole(ctx, ["owner", "admin"], "create API keys");
  const { name } = parseInput(createApiKeyInput, input);
  await findAgent(db, ctx.orgId, agentActorId);

  const secret = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiTokens)
      .values({
        actorId: agentActorId,
        name,
        tokenHash: hashApiKey(secret),
        prefix: secret.slice(0, KEY_PREFIX.length + 6),
        createdBy: ctx.actorId,
      })
      .returning();
    if (!row) throw new Error("Failed to create API key");
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: agentActorId,
      action: "api_key.created",
      changes: { keyId: row.id, name },
    });
    return { key: toApiKeyDto(row), secret };
  });
}

export async function revokeApiKey(db: Db, ctx: ActorContext, keyId: string) {
  assertRole(ctx, ["owner", "admin"], "revoke API keys");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: apiTokens.id, actorId: apiTokens.actorId })
      .from(apiTokens)
      .innerJoin(actors, eq(apiTokens.actorId, actors.id))
      .where(and(eq(apiTokens.id, keyId), eq(actors.orgId, ctx.orgId)))
      .limit(1);
    if (!row) throw new DomainError("not_found", "API key not found");
    await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, keyId), isNull(apiTokens.revokedAt)));
    await recordActivity(tx, ctx, { entityType: "actor", entityId: row.actorId, action: "api_key.revoked", changes: { keyId } });
  });
}

/** Resolves an API key to its agent and organization; null if unknown, revoked or expired. */
export async function authenticateApiKey(db: Db, secret: string) {
  if (!secret.startsWith(KEY_PREFIX)) return null;
  const [row] = await db
    .select({ token: apiTokens, actor: actors, organization: organizations })
    .from(apiTokens)
    .innerJoin(actors, eq(apiTokens.actorId, actors.id))
    .innerJoin(organizations, eq(actors.orgId, organizations.id))
    .where(and(eq(apiTokens.tokenHash, hashApiKey(secret)), isNull(apiTokens.revokedAt), isNull(actors.deactivatedAt)))
    .limit(1);
  if (!row) return null;
  const now = new Date();
  if (row.token.expiresAt && row.token.expiresAt <= now) return null;

  // Record usage at most once a minute per key.
  if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id));
  }
  return { actor: row.actor, organization: row.organization };
}
