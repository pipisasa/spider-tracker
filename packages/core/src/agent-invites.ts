import { randomInt } from "node:crypto";
import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { assertRole, type ActivitySource, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import {
  agentProjectRefs,
  assertCanCreateAgent,
  assertCanManageAgent,
  issueApiKey,
} from "./agents";
import type {
  AgentInviteDto,
  CreatedAgentInviteDto,
  ProjectRefDto,
} from "./contracts";
import { DomainError } from "./errors";
import { handleFrom } from "./handles";
import {
  formatInvitationCode,
  generateInvitationCode,
  normalizeInvitationCode,
  uniqueHandle,
} from "./invitations";
import { acceptAgentInviteInput, createAgentInviteInput } from "./schemas";
import { parseInput } from "./validate";

// Agent invites (ST-31): a person creates a one-time code for a pending agent limited to some
// projects; whoever holds the code (an agent setting itself up) accepts it, without a session,
// and receives the agent's first API key. Pending agents stay deactivated until then, so they
// never show up as members, assignees or mention targets.

const { actors, agentInvites, agentProjects, agents, organizations, projects } =
  schema;

const INVALID_CODE = "Invalid or expired invitation code";
const PLACEHOLDER_NAME = "New agent";
const HANDLE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** Expired invites stay listed this long, so they can be revoked (which frees the handle). */
const LIST_RETENTION_DAYS = 7;

type InviteRow = typeof agentInvites.$inferSelect;

/**
 * Removes pending agents whose unused invite expired more than LIST_RETENTION_DAYS ago: they are
 * no longer listed, so nobody could revoke them. Deleting the actor cascades to the invite and
 * its project rows, like a revoke.
 */
async function purgeExpiredPendingAgents(db: Db | Tx, orgId: string) {
  await db.delete(actors).where(
    and(
      eq(actors.type, "agent"),
      isNotNull(actors.deactivatedAt),
      inArray(
        actors.id,
        db
          .select({ id: agentInvites.agentId })
          .from(agentInvites)
          .where(
            and(
              eq(agentInvites.orgId, orgId),
              isNull(agentInvites.usedAt),
              isNull(agentInvites.revokedAt),
              sql`${agentInvites.expiresAt} <= now() - make_interval(days => ${LIST_RETENTION_DAYS})`,
            ),
          ),
      ),
    ),
  );
}

function placeholderHandle(): string {
  let suffix = "";
  for (let i = 0; i < 4; i++)
    suffix += HANDLE_ALPHABET[randomInt(HANDLE_ALPHABET.length)];
  return `agent-${suffix}`;
}

/** Accepts a bare code (any case, dashes, spaces) or a link ending in the code or carrying `code=`. */
export function normalizeAgentInviteCode(input: string): string {
  let raw = input.trim();
  const query = /[?&]code=([^&#\s]+)/i.exec(raw);
  if (query?.[1]) raw = query[1];
  else if (raw.includes("/"))
    raw =
      raw
        .replace(/[/?#]+$/, "")
        .split(/[/?#]/)
        .pop() ?? "";
  return normalizeInvitationCode(raw);
}

function toInviteDto(
  row: InviteRow,
  agent: AgentInviteDto["agent"],
  projectRefs: ProjectRefDto[],
  now = new Date(),
): AgentInviteDto {
  return {
    id: row.id,
    code: formatInvitationCode(row.code),
    status: row.expiresAt <= now ? "expired" : "pending",
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    agent,
    projects: projectRefs,
  };
}

/** Creates a pending agent owned by the caller, limited to the given projects, and its one-time code. */
export async function createAgentInvite(
  db: Db,
  ctx: ActorContext,
  input: unknown,
): Promise<CreatedAgentInviteDto> {
  await assertCanCreateAgent(db, ctx);
  const data = parseInput(createAgentInviteInput, input);
  const keys = [...new Set(data.projectKeys.map((k) => k.toUpperCase()))];
  const expiresAt = new Date(
    Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000,
  );

  return db.transaction(async (tx) => {
    await purgeExpiredPendingAgents(tx, ctx.orgId);
    const found = await tx
      .select({ id: projects.id, key: projects.key, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, ctx.orgId),
          inArray(projects.key, keys),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(projects.key));
    const missing = keys.find((k) => !found.some((p) => p.key === k));
    if (missing)
      throw new DomainError("not_found", `Project ${missing} not found`);

    let actor: typeof actors.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5 && !actor; attempt++) {
      [actor] = await tx
        .insert(actors)
        .values({
          orgId: ctx.orgId,
          type: "agent",
          name: PLACEHOLDER_NAME,
          handle: placeholderHandle(),
          role: "member",
          deactivatedAt: new Date(),
        })
        .onConflictDoNothing({ target: [actors.orgId, actors.handle] })
        .returning();
    }
    if (!actor)
      throw new Error("Failed to pick a handle for the pending agent");
    await tx
      .insert(agents)
      .values({ actorId: actor.id, ownerId: ctx.actorId, scoped: true });
    await tx
      .insert(agentProjects)
      .values(found.map((p) => ({ agentId: actor.id, projectId: p.id })));

    let invite: InviteRow | undefined;
    for (let attempt = 0; attempt < 5 && !invite; attempt++) {
      [invite] = await tx
        .insert(agentInvites)
        .values({
          orgId: ctx.orgId,
          code: generateInvitationCode(),
          agentId: actor.id,
          createdBy: ctx.actorId,
          expiresAt,
        })
        .onConflictDoNothing({ target: agentInvites.code })
        .returning();
    }
    if (!invite) throw new Error("Failed to generate a unique invitation code");

    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: actor.id,
      action: "agent_invite.created",
      changes: {
        inviteId: invite.id,
        projects: found.map((p) => p.key),
        expiresAt: invite.expiresAt.toISOString(),
      },
    });
    const agent = { id: actor.id, name: actor.name, handle: actor.handle };
    return {
      invite: toInviteDto(
        invite,
        agent,
        found.map(({ key, name }) => ({ key, name })),
      ),
      agent,
    };
  });
}

/** Unused, unrevoked invites for agents the caller can manage (recently expired ones included). */
export async function listAgentInvites(
  db: Db,
  ctx: ActorContext,
): Promise<AgentInviteDto[]> {
  assertRole(ctx, ["owner", "admin", "member"], "see agent invites");
  await purgeExpiredPendingAgents(db, ctx.orgId);
  const rows = await db
    .select({
      invite: agentInvites,
      agent: { id: actors.id, name: actors.name, handle: actors.handle },
      ownerId: agents.ownerId,
    })
    .from(agentInvites)
    .innerJoin(actors, eq(agentInvites.agentId, actors.id))
    .innerJoin(agents, eq(agents.actorId, actors.id))
    .where(
      and(
        eq(agentInvites.orgId, ctx.orgId),
        isNull(agentInvites.usedAt),
        isNull(agentInvites.revokedAt),
        sql`${agentInvites.expiresAt} > now() - make_interval(days => ${LIST_RETENTION_DAYS})`,
        ctx.role === "owner" || ctx.role === "admin"
          ? undefined
          : eq(agents.ownerId, ctx.actorId),
      ),
    )
    .orderBy(desc(agentInvites.createdAt));
  const refs = await agentProjectRefs(
    db,
    rows.map((r) => r.agent.id),
  );
  return rows.map((r) =>
    toInviteDto(r.invite, r.agent, refs.get(r.agent.id) ?? []),
  );
}

/** Revokes an unused invite and removes its pending agent (freeing the handle). */
export async function revokeAgentInvite(
  db: Db,
  ctx: ActorContext,
  inviteId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ invite: agentInvites, ownerId: agents.ownerId })
      .from(agentInvites)
      .innerJoin(agents, eq(agents.actorId, agentInvites.agentId))
      .where(
        and(
          sql`${agentInvites.id}::text = ${inviteId}`,
          eq(agentInvites.orgId, ctx.orgId),
        ),
      )
      .limit(1)
      .for("update", { of: agentInvites });
    if (!row || row.invite.revokedAt)
      throw new DomainError("not_found", "Invite not found");
    assertCanManageAgent(ctx, row);
    if (row.invite.usedAt)
      throw new DomainError(
        "conflict",
        "This invite was already used; delete the agent instead",
      );
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: row.invite.agentId,
      action: "agent_invite.revoked",
      changes: { inviteId: row.invite.id },
    });
    // Cascades to the invite and the agent's project rows.
    await tx.delete(actors).where(eq(actors.id, row.invite.agentId));
  });
}

async function assertHandleFree(
  tx: Tx,
  orgId: string,
  handle: string,
  selfId: string,
) {
  const [taken] = await tx
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.orgId, orgId), eq(actors.handle, handle)))
    .limit(1);
  if (taken && taken.id !== selfId)
    throw new DomainError("conflict", `Handle @${handle} is already used`);
}

/**
 * Accepts an agent invite: the code is the credential, no session needed. Activates the pending
 * agent (applying the optional name, handle and description) and returns its first API key.
 * A failed check (e.g. a taken handle) rolls everything back, so the code stays usable.
 */
export async function acceptAgentInvite(
  db: Db,
  input: unknown,
  source: ActivitySource = "api",
) {
  const data = parseInput(acceptAgentInviteInput, input);
  const code = normalizeAgentInviteCode(data.code);
  const owners = schema.actors;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ invite: agentInvites, organization: organizations })
      .from(agentInvites)
      .innerJoin(organizations, eq(agentInvites.orgId, organizations.id))
      .where(eq(agentInvites.code, code))
      .limit(1)
      .for("update", { of: agentInvites });
    // One message for unknown, used, revoked and expired codes, so codes can't be probed.
    if (
      !row ||
      row.invite.usedAt ||
      row.invite.revokedAt ||
      row.invite.expiresAt <= new Date()
    ) {
      throw new DomainError("validation", INVALID_CODE);
    }
    const { invite, organization } = row;

    const [agentRow] = await tx
      .select({ actor: actors, ownerId: agents.ownerId })
      .from(actors)
      .innerJoin(agents, eq(agents.actorId, actors.id))
      .where(eq(actors.id, invite.agentId))
      .limit(1);
    const [owner] = agentRow
      ? await tx
          .select({
            id: owners.id,
            name: owners.name,
            handle: owners.handle,
            deactivatedAt: owners.deactivatedAt,
          })
          .from(owners)
          .where(eq(owners.id, agentRow.ownerId))
          .limit(1)
      : [];
    if (!agentRow || !owner || owner.deactivatedAt)
      throw new DomainError("validation", INVALID_CODE);

    const name = data.name ?? agentRow.actor.name;
    let handle = data.handle ?? agentRow.actor.handle;
    if (data.handle)
      await assertHandleFree(
        tx,
        organization.id,
        data.handle,
        agentRow.actor.id,
      );
    else if (data.name)
      handle = await uniqueHandle(tx, organization.id, handleFrom(data.name));

    const [actor] = await tx
      .update(actors)
      .set({ name, handle, deactivatedAt: null })
      .where(eq(actors.id, agentRow.actor.id))
      .returning();
    if (!actor) throw new Error("Failed to activate agent");
    if (data.description !== undefined) {
      await tx
        .update(agents)
        .set({ description: data.description || null })
        .where(eq(agents.actorId, actor.id));
    }
    await tx
      .update(agentInvites)
      .set({ usedAt: new Date() })
      .where(eq(agentInvites.id, invite.id));

    const ctx: ActorContext = {
      orgId: organization.id,
      actorId: actor.id,
      role: actor.role,
      source,
    };
    await recordActivity(tx, ctx, {
      entityType: "actor",
      entityId: actor.id,
      action: "agent_invite.accepted",
      changes: { inviteId: invite.id, name, handle },
    });
    const { secret } = await issueApiKey(tx, ctx, actor.id, "invite");
    const refs = await agentProjectRefs(tx, [actor.id]);
    return {
      token: secret,
      actor,
      organization: {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
      },
      projects: refs.get(actor.id) ?? [],
      owner: { id: owner.id, name: owner.name, handle: owner.handle },
    };
  });
}
