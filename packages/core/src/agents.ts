import { createHash, randomBytes } from "node:crypto";
import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { assertRole, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { ApiKeyDto, CreatedApiKeyDto, ProjectRefDto } from "./contracts";
import { DomainError, isUniqueViolation } from "./errors";
import { handleFrom } from "./handles";
import { isUuid } from "./ids";
import {
  createAgentInput,
  createApiKeyInput,
  updateAgentInput,
} from "./schemas";
import { parseInput } from "./validate";

const { actors, agentProjects, agents, apiTokens, organizations, projects } =
  schema;

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

/** Agents are created by people who can work in the organization; never by guests or agent keys. */
export async function assertCanCreateAgent(db: Db, ctx: ActorContext) {
  assertRole(ctx, ["owner", "admin", "member"], "create agents");
  const [me] = await db
    .select({ type: actors.type })
    .from(actors)
    .where(eq(actors.id, ctx.actorId))
    .limit(1);
  if (me?.type !== "human")
    throw new DomainError("forbidden", "Agents can't create agents");
}

function canManageAgent(ctx: ActorContext, agent: { ownerId: string }) {
  return (
    agent.ownerId === ctx.actorId ||
    ctx.role === "owner" ||
    ctx.role === "admin"
  );
}

/** An agent is managed (edited, deleted, keys issued and revoked) by its owner or an organization owner/admin. */
export function assertCanManageAgent(
  ctx: ActorContext,
  agent: { ownerId: string },
) {
  if (!canManageAgent(ctx, agent))
    throw new DomainError(
      "forbidden",
      "Only the agent's owner or an admin can manage it",
    );
}

/** Creates an external agent member owned by the acting person. */
export async function createAgent(db: Db, ctx: ActorContext, input: unknown) {
  await assertCanCreateAgent(db, ctx);
  const data = parseInput(createAgentInput, input);
  const handle = data.handle ?? handleFrom(data.name);

  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: actors.id, name: actors.name, handle: actors.handle })
      .from(actors)
      .where(eq(actors.id, ctx.actorId))
      .limit(1);
    if (!owner) throw new DomainError("not_found", "Member not found");
    // Creators are owners, admins or members, so "member" never exceeds the owner's role.
    const [actor] = await tx
      .insert(actors)
      .values({
        orgId: ctx.orgId,
        type: "agent",
        name: data.name,
        handle,
        role: "member",
      })
      .onConflictDoNothing({ target: [actors.orgId, actors.handle] })
      .returning();
    if (!actor)
      throw new DomainError("conflict", `Handle @${handle} is already used`);

    await tx.insert(agents).values({
      actorId: actor.id,
      ownerId: ctx.actorId,
      description: data.description ?? null,
    });
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: actor.id,
      action: "agent.created",
      changes: { name: data.name, handle },
    });
    return {
      actor,
      ownerId: ctx.actorId,
      owner,
      description: data.description ?? null,
      canManage: true,
      keys: [] as ApiKeyDto[],
      projects: null as ProjectRefDto[] | null,
    };
  });
}

/** Active agents of the organization; keys only for the ones the caller can manage. */
export function listAgents(db: Db, ctx: ActorContext) {
  return queryAgents(db, ctx);
}

async function queryAgents(db: Db, ctx: ActorContext, agentActorId?: string) {
  const owners = alias(actors, "owner");
  const rows = await db
    .select({
      actor: actors,
      agent: agents,
      owner: { id: owners.id, name: owners.name, handle: owners.handle },
    })
    .from(agents)
    .innerJoin(actors, eq(agents.actorId, actors.id))
    .innerJoin(owners, eq(agents.ownerId, owners.id))
    .where(
      and(
        eq(actors.orgId, ctx.orgId),
        isNull(actors.deactivatedAt),
        agentActorId ? eq(actors.id, agentActorId) : undefined,
      ),
    )
    .orderBy(asc(actors.name));
  const manageable = rows
    .filter((r) => canManageAgent(ctx, r.agent))
    .map((r) => r.actor.id);
  const keys =
    manageable.length === 0
      ? []
      : await db
          .select()
          .from(apiTokens)
          .where(inArray(apiTokens.actorId, manageable))
          .orderBy(asc(apiTokens.createdAt));
  const scopes = await agentProjectRefs(
    db,
    rows.map((r) => r.actor.id),
  );
  return rows.map(({ actor, agent, owner }) => ({
    actor,
    ownerId: agent.ownerId,
    owner,
    description: agent.description,
    canManage: manageable.includes(actor.id),
    keys: keys.filter((k) => k.actorId === actor.id).map(toApiKeyDto),
    projects: scopes.get(actor.id) ?? (agent.scoped ? [] : null),
  }));
}

/** Project keys and names each agent is limited to; agents without rows are absent. */
export async function agentProjectRefs(db: Db | Tx, agentActorIds: string[]) {
  const map = new Map<string, ProjectRefDto[]>();
  if (agentActorIds.length === 0) return map;
  const rows = await db
    .select({
      agentId: agentProjects.agentId,
      key: projects.key,
      name: projects.name,
    })
    .from(agentProjects)
    .innerJoin(projects, eq(agentProjects.projectId, projects.id))
    .where(inArray(agentProjects.agentId, agentActorIds))
    .orderBy(asc(projects.key));
  for (const { agentId, key, name } of rows) {
    const list = map.get(agentId) ?? [];
    list.push({ key, name });
    map.set(agentId, list);
  }
  return map;
}

async function findAgent(db: Db | Tx, orgId: string, agentActorId: string) {
  if (!isUuid(agentActorId))
    throw new DomainError("not_found", "Agent not found");
  const [row] = await db
    .select({
      actor: actors,
      ownerId: agents.ownerId,
      description: agents.description,
    })
    .from(agents)
    .innerJoin(actors, eq(agents.actorId, actors.id))
    .where(
      and(
        eq(actors.id, agentActorId),
        eq(actors.orgId, orgId),
        isNull(actors.deactivatedAt),
      ),
    )
    .limit(1);
  if (!row) throw new DomainError("not_found", "Agent not found");
  return row;
}

/**
 * Renames an agent, changes its handle (unique in the organization) or description.
 * An agent may update these three fields on itself.
 */
export async function updateAgent(
  db: Db,
  ctx: ActorContext,
  agentActorId: string,
  input: unknown,
) {
  const data = parseInput(updateAgentInput, input);
  const current = await findAgent(db, ctx.orgId, agentActorId);
  if (ctx.actorId !== agentActorId) assertCanManageAgent(ctx, current);

  await db.transaction(async (tx) => {
    const changes: Record<string, unknown> = {};
    const actorPatch: { name?: string; handle?: string } = {};
    if (data.name !== undefined && data.name !== current.actor.name)
      actorPatch.name = changes.name = data.name;
    if (data.handle !== undefined && data.handle !== current.actor.handle) {
      const [taken] = await tx
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.orgId, ctx.orgId), eq(actors.handle, data.handle)))
        .limit(1);
      if (taken)
        throw new DomainError(
          "conflict",
          `Handle @${data.handle} is already used`,
        );
      actorPatch.handle = changes.handle = data.handle;
    }
    if (Object.keys(actorPatch).length > 0) {
      try {
        await tx
          .update(actors)
          .set(actorPatch)
          .where(eq(actors.id, agentActorId));
      } catch (err) {
        // Someone took the handle between the check above and this update.
        if (isUniqueViolation(err, "actors_org_handle_key"))
          throw new DomainError(
            "conflict",
            `Handle @${data.handle} is already used`,
          );
        throw err;
      }
    }
    if (
      data.description !== undefined &&
      (data.description || null) !== current.description
    ) {
      const description = data.description || null;
      changes.description = description;
      await tx
        .update(agents)
        .set({ description })
        .where(eq(agents.actorId, agentActorId));
    }
    if (Object.keys(changes).length > 0) {
      await recordActivity(tx, ctx, {
        entityType: "actor",
        entityId: agentActorId,
        action: "agent.updated",
        changes,
      });
    }
  });
  const [agent] = await queryAgents(db, ctx, agentActorId);
  if (!agent) throw new DomainError("not_found", "Agent not found");
  return agent;
}

/** Deactivates an agent (history and assignments stay) and revokes all its keys. */
export async function deleteAgent(
  db: Db,
  ctx: ActorContext,
  agentActorId: string,
) {
  const current = await findAgent(db, ctx.orgId, agentActorId);
  assertCanManageAgent(ctx, current);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(actors)
      .set({ deactivatedAt: now })
      .where(eq(actors.id, agentActorId));
    const revoked = await tx
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(apiTokens.actorId, agentActorId), isNull(apiTokens.revokedAt)),
      )
      .returning({ id: apiTokens.id });
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: agentActorId,
      action: "agent.deleted",
      changes: { revokedKeyIds: revoked.map((r) => r.id) },
    });
  });
}

/** Inserts a key row for an agent and records it; returns the secret, which is never stored. */
export async function issueApiKey(
  tx: Tx,
  ctx: ActorContext,
  agentActorId: string,
  name: string,
): Promise<CreatedApiKeyDto> {
  const secret = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
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
}

/** Issues a new API key for an agent. The secret is returned only here. */
export async function createApiKey(
  db: Db,
  ctx: ActorContext,
  agentActorId: string,
  input: unknown,
): Promise<CreatedApiKeyDto> {
  const { name } = parseInput(createApiKeyInput, input);
  assertCanManageAgent(ctx, await findAgent(db, ctx.orgId, agentActorId));
  return db.transaction((tx) => issueApiKey(tx, ctx, agentActorId, name));
}

export async function revokeApiKey(db: Db, ctx: ActorContext, keyId: string) {
  if (!isUuid(keyId)) throw new DomainError("not_found", "API key not found");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: apiTokens.id,
        actorId: apiTokens.actorId,
        ownerId: agents.ownerId,
      })
      .from(apiTokens)
      .innerJoin(actors, eq(apiTokens.actorId, actors.id))
      .innerJoin(agents, eq(agents.actorId, actors.id))
      .where(and(eq(apiTokens.id, keyId), eq(actors.orgId, ctx.orgId)))
      .limit(1);
    if (!row) throw new DomainError("not_found", "API key not found");
    assertCanManageAgent(ctx, row);
    await tx
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, keyId), isNull(apiTokens.revokedAt)));
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: row.actorId,
      action: "api_key.revoked",
      changes: { keyId },
    });
  });
}

/** Resolves an API key to its agent and organization; null if unknown, revoked, expired, or its agent or owner is deactivated. */
export async function authenticateApiKey(db: Db, secret: string) {
  if (!secret.startsWith(KEY_PREFIX)) return null;
  const owners = alias(actors, "owner");
  const [row] = await db
    .select({
      token: apiTokens,
      actor: actors,
      organization: organizations,
      ownerId: agents.ownerId,
    })
    .from(apiTokens)
    .innerJoin(actors, eq(apiTokens.actorId, actors.id))
    .innerJoin(organizations, eq(actors.orgId, organizations.id))
    .innerJoin(agents, eq(agents.actorId, actors.id))
    .innerJoin(owners, eq(agents.ownerId, owners.id))
    .where(
      and(
        eq(apiTokens.tokenHash, hashApiKey(secret)),
        isNull(apiTokens.revokedAt),
        isNull(actors.deactivatedAt),
        isNull(owners.deactivatedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const now = new Date();
  if (row.token.expiresAt && row.token.expiresAt <= now) return null;

  // Record usage at most once a minute per key.
  if (
    !row.token.lastUsedAt ||
    now.getTime() - row.token.lastUsedAt.getTime() > 60_000
  ) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(eq(apiTokens.id, row.token.id));
  }
  return {
    actor: row.actor,
    organization: row.organization,
    ownerId: row.ownerId,
    keyId: row.token.id,
  };
}

/** Revokes the key a request authenticated with (`spider logout`). */
export async function revokeCurrentApiKey(
  db: Db,
  ctx: ActorContext,
  keyId: string,
) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, keyId),
          eq(apiTokens.actorId, ctx.actorId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id });
    if (!row) throw new DomainError("not_found", "API key not found");
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: ctx.actorId,
      action: "api_key.revoked",
      changes: { keyId },
    });
  });
}
