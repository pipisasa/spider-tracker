import { randomInt } from "node:crypto";
import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, desc, eq, gt, like, or, sql } from "drizzle-orm";
import { assertRole, type ActivitySource, type ActorContext } from "./access";
import { recordActivity } from "./activity";
import type { InvitationDto, InvitationStatus } from "./contracts";
import { DomainError, isUniqueViolation } from "./errors";
import { handleFrom } from "./handles";
import { isUuid } from "./ids";
import type { UserIdentity } from "./organizations";
import { createInvitationInput, invitationCodeInput } from "./schemas";
import { parseInput } from "./validate";

const { actors, invitations, organizations } = schema;

// No 0/O, 1/I/L: codes are read aloud and typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
/** Expired and revoked codes stay listed this long. */
const LIST_RETENTION_DAYS = 7;
const INVALID_CODE = "Invalid or expired invitation code";

type InvitationRow = typeof invitations.$inferSelect;
type InvitationRole = InvitationDto["role"];

export function generateInvitationCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Uppercase, without dashes or spaces: the stored form. */
export function normalizeInvitationCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

export function formatInvitationCode(code: string): string {
  return code.length === CODE_LENGTH
    ? `${code.slice(0, 4)}-${code.slice(4)}`
    : code;
}

function statusOf(row: InvitationRow, now = new Date()): InvitationStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now) return "expired";
  if (row.maxUses !== null && row.useCount >= row.maxUses) return "used_up";
  return "active";
}

function invitationRole(role: InvitationRow["role"]): InvitationRole {
  if (role === "owner")
    throw new Error("Invitations never grant the owner role");
  return role;
}

function toInvitationDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    code: formatInvitationCode(row.code),
    role: invitationRole(row.role),
    status: statusOf(row),
    useCount: row.useCount,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Creates an invitation code (owners and admins; only owners may invite admins). */
export async function createInvitation(
  db: Db,
  ctx: ActorContext,
  input: unknown,
): Promise<InvitationDto> {
  assertRole(ctx, ["owner", "admin"], "invite people");
  const data = parseInput(createInvitationInput, input);
  if (data.role === "admin") assertRole(ctx, ["owner"], "invite admins");
  const expiresAt = new Date(
    Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000,
  );

  return db.transaction(async (tx) => {
    // A collision in 31^8 codes is unlikely; retry a few times anyway.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await tx
        .insert(invitations)
        .values({
          orgId: ctx.orgId,
          code: generateInvitationCode(),
          role: data.role,
          createdBy: ctx.actorId,
          expiresAt,
          maxUses: data.maxUses ?? null,
        })
        .onConflictDoNothing({ target: invitations.code })
        .returning();
      if (!row) continue;
      await recordActivity(tx, ctx, {
        entityType: "invitation",
        entityId: row.id,
        action: "invitation.created",
        changes: {
          role: row.role,
          expiresAt: row.expiresAt.toISOString(),
          maxUses: row.maxUses,
        },
      });
      return toInvitationDto(row);
    }
    throw new Error("Failed to generate a unique invitation code");
  });
}

/** Active codes, plus ones that expired or were revoked recently (owners and admins). */
export async function listInvitations(
  db: Db,
  ctx: ActorContext,
): Promise<InvitationDto[]> {
  assertRole(ctx, ["owner", "admin"], "see invitations");
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.orgId, ctx.orgId),
        gt(
          invitations.expiresAt,
          sql`now() - make_interval(days => ${LIST_RETENTION_DAYS})`,
        ),
        or(
          sql`${invitations.revokedAt} is null`,
          gt(
            invitations.revokedAt,
            sql`now() - make_interval(days => ${LIST_RETENTION_DAYS})`,
          ),
        ),
      ),
    )
    .orderBy(desc(invitations.createdAt));
  return rows.map(toInvitationDto);
}

/** Revokes a code so it can no longer be used. */
export async function revokeInvitation(
  db: Db,
  ctx: ActorContext,
  invitationId: string,
): Promise<void> {
  assertRole(ctx, ["owner", "admin"], "revoke invitations");
  if (!isUuid(invitationId))
    throw new DomainError("not_found", "Invitation not found");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(invitations)
      .set({ revokedAt: sql`coalesce(${invitations.revokedAt}, now())` })
      .where(
        and(eq(invitations.id, invitationId), eq(invitations.orgId, ctx.orgId)),
      )
      .returning({ id: invitations.id });
    if (!row) throw new DomainError("not_found", "Invitation not found");
    await recordActivity(tx, ctx, {
      entityType: "invitation",
      entityId: row.id,
      action: "invitation.revoked",
    });
  });
}

async function findUsableInvitation(
  db: Db | Tx,
  rawCode: string,
  lock: boolean,
) {
  const { code } = parseInput(invitationCodeInput, { code: rawCode });
  const normalized = normalizeInvitationCode(code);
  const query = db
    .select({ invitation: invitations, organization: organizations })
    .from(invitations)
    .innerJoin(organizations, eq(invitations.orgId, organizations.id))
    .where(eq(invitations.code, normalized))
    .limit(1);
  const [row] = lock
    ? await query.for("update", { of: invitations })
    : await query;
  // One message for unknown, expired, revoked and used-up codes, so codes can't be probed.
  if (!row || statusOf(row.invitation) !== "active")
    throw new DomainError("validation", INVALID_CODE);
  return row;
}

/** What a code would join, for a "Join <org> as member?" prompt. */
export async function previewInvitation(
  db: Db,
  userId: string,
  input: unknown,
) {
  const { code } = parseInput(invitationCodeInput, input);
  const { invitation, organization } = await findUsableInvitation(
    db,
    code,
    false,
  );
  const [existing] = await db
    .select({ id: actors.id })
    .from(actors)
    .where(
      and(
        eq(actors.orgId, organization.id),
        eq(actors.userId, userId),
        sql`${actors.deactivatedAt} is null`,
      ),
    )
    .limit(1);
  return {
    organization: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
    },
    role: invitationRole(invitation.role),
    alreadyMember: !!existing,
  };
}

/** A handle like `jane`, or `jane-2`, `jane-3`… when taken in the organization. */
export async function uniqueHandle(
  tx: Tx,
  orgId: string,
  base: string,
): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ handle: actors.handle })
        .from(actors)
        .where(
          and(
            eq(actors.orgId, orgId),
            or(eq(actors.handle, base), like(actors.handle, `${base}-%`)),
          ),
        )
    ).map((r) => r.handle),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Joins the organization a code belongs to, as a person with the code's role. */
export async function acceptInvitation(
  db: Db,
  user: UserIdentity,
  input: unknown,
  source: ActivitySource = "ui",
) {
  const { code } = parseInput(invitationCodeInput, input);

  return db.transaction(async (tx) => {
    // Locks the invitation row so concurrent joins can't exceed max uses.
    const { invitation, organization } = await findUsableInvitation(
      tx,
      code,
      true,
    );
    const role = invitationRole(invitation.role);

    const [existing] = await tx
      .select()
      .from(actors)
      .where(and(eq(actors.orgId, organization.id), eq(actors.userId, user.id)))
      .limit(1);
    if (existing && !existing.deactivatedAt) {
      throw new DomainError(
        "conflict",
        `You're already a member of ${organization.name}`,
      );
    }

    let actor: typeof actors.$inferSelect | undefined;
    if (existing) {
      // A former member comes back with their old handle and the code's role.
      [actor] = await tx
        .update(actors)
        .set({ deactivatedAt: null, role })
        .where(eq(actors.id, existing.id))
        .returning();
    } else {
      // A concurrent join can take the picked handle; pick the next free one.
      for (let attempt = 0; attempt < 5 && !actor; attempt++) {
        try {
          [actor] = await tx
            .insert(actors)
            .values({
              orgId: organization.id,
              type: "human",
              userId: user.id,
              name: user.name || user.email,
              handle: await uniqueHandle(
                tx,
                organization.id,
                handleFrom(user.email),
              ),
              avatarUrl: user.image ?? null,
              role,
            })
            .onConflictDoNothing({ target: [actors.orgId, actors.handle] })
            .returning();
        } catch (err) {
          // The same person joining twice at once (e.g. with two codes).
          if (isUniqueViolation(err, "actors_org_user_key"))
            throw new DomainError(
              "conflict",
              `You're already a member of ${organization.name}`,
            );
          throw err;
        }
      }
      if (!actor)
        throw new DomainError(
          "conflict",
          "Couldn't pick a free handle; please try again",
        );
    }
    if (!actor) throw new Error("Failed to add member");

    await tx
      .update(invitations)
      .set({ useCount: sql`${invitations.useCount} + 1` })
      .where(eq(invitations.id, invitation.id));
    await recordActivity(
      tx,
      { orgId: organization.id, actorId: actor.id, role, source },
      {
        entityType: "actor",
        entityId: actor.id,
        action: "member.joined",
        changes: { invitationId: invitation.id, role },
      },
    );
    return { organization, actor };
  });
}
