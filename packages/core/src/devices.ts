import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, isNull, like, lt } from "drizzle-orm";
import { assertRole, resolveMembership, type ActorContext } from "./access";
import { issueApiKey } from "./agents";
import { recordActivity } from "./activity";
import type { DeviceRequestDto } from "./contracts";
import { DomainError } from "./errors";
import { handleFrom } from "./handles";
import { deviceCodeInput } from "./schemas";
import { parseInput } from "./validate";

// OAuth 2.0 device authorization grant (RFC 8628) behind `spider login`.

const { actors, agents, deviceCodes, organizations } = schema;

export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

// No vowels, so codes never spell words; no easily confused letters (RFC 8628 §6.1).
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const hash = (deviceCode: string) =>
  createHash("sha256").update(deviceCode).digest("hex");

function newUserCode() {
  const chars = Array.from(
    { length: 8 },
    () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)],
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Accepts "wdjb mjht", "WDJBMJHT" or "WDJB-MJHT". */
export function normalizeUserCode(input: string) {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : null;
}

export async function startDeviceAuthorization(db: Db, input: unknown) {
  const { client_name: clientName } = parseInput(deviceCodeInput, input ?? {});
  await db
    .delete(deviceCodes)
    .where(
      lt(
        deviceCodes.expiresAt,
        new Date(Date.now() - DEVICE_CODE_RETENTION_MS),
      ),
    );
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = newUserCode();
  await db.insert(deviceCodes).values({
    deviceCodeHash: hash(deviceCode),
    userCode,
    clientName,
    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000),
  });
  return { deviceCode, userCode };
}

async function findByUserCode(db: Db, userCode: string) {
  const code = normalizeUserCode(userCode);
  const [row] = code
    ? await db
        .select()
        .from(deviceCodes)
        .where(eq(deviceCodes.userCode, code))
        .limit(1)
    : [];
  if (!row)
    throw new DomainError(
      "not_found",
      "That code isn't valid. Check it in your terminal and try again",
    );
  return row;
}

export async function getDeviceRequest(
  db: Db,
  userCode: string,
): Promise<DeviceRequestDto> {
  const row = await findByUserCode(db, userCode);
  return {
    userCode: row.userCode,
    clientName: row.clientName,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** The signed-in person approves (for one of their organizations) or denies a pending login. */
export async function decideDevice(
  db: Db,
  userId: string,
  userCode: string,
  decision: { approve: true; orgSlug: string } | { approve: false },
) {
  const row = await findByUserCode(db, userCode);
  if (row.status !== "pending")
    throw new DomainError("conflict", "This code has already been used");
  if (row.expiresAt <= new Date())
    throw new DomainError(
      "validation",
      "This code has expired. Run spider login again",
    );

  const pending = and(
    eq(deviceCodes.id, row.id),
    eq(deviceCodes.status, "pending"),
  );
  let updated: { id: string }[];
  if (!decision.approve) {
    updated = await db
      .update(deviceCodes)
      .set({ status: "denied" })
      .where(pending)
      .returning({ id: deviceCodes.id });
  } else {
    const { organization, actor } = await resolveMembership(
      db,
      userId,
      decision.orgSlug,
    );
    if (actor.type !== "human")
      throw new DomainError("forbidden", "Only people can approve devices");
    // The device becomes an agent; guests can't create agents.
    assertRole(
      {
        orgId: organization.id,
        actorId: actor.id,
        role: actor.role,
        source: "api",
      },
      ["owner", "admin", "member"],
      "connect devices",
    );
    updated = await db
      .update(deviceCodes)
      .set({ status: "approved", orgId: organization.id, decidedBy: actor.id })
      .where(pending)
      .returning({ id: deviceCodes.id });
  }
  if (updated.length === 0)
    throw new DomainError("conflict", "This code has already been used");
}

export type DevicePollResult =
  | {
      status:
        | "authorization_pending"
        | "slow_down"
        | "expired_token"
        | "access_denied"
        | "invalid_grant";
    }
  | {
      status: "approved";
      secret: string;
      actor: typeof actors.$inferSelect;
      /** The approver, who owns the device's agent. */
      ownerId: string;
      organization: typeof organizations.$inferSelect;
    };

/**
 * Exchanges a device code for an API key once approved. The device gets its own agent
 * member owned by the approver ("spider CLI · MacBook"), reused on later logins.
 */
export async function pollDeviceToken(
  db: Db,
  deviceCode: string,
): Promise<DevicePollResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCodeHash, hash(deviceCode)))
      .for("update")
      .limit(1);
    if (!row || row.status === "consumed") return { status: "invalid_grant" };

    const now = new Date();
    const tooSoon =
      row.lastPolledAt &&
      now.getTime() - row.lastPolledAt.getTime() <
        (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000;
    await tx
      .update(deviceCodes)
      .set({ lastPolledAt: now })
      .where(eq(deviceCodes.id, row.id));

    if (row.status === "denied") return { status: "access_denied" };
    if (row.expiresAt <= now) return { status: "expired_token" };
    if (tooSoon) return { status: "slow_down" };
    if (row.status === "pending") return { status: "authorization_pending" };
    if (!row.orgId || !row.decidedBy) return { status: "invalid_grant" };

    const [approver] = await tx
      .select()
      .from(actors)
      .where(eq(actors.id, row.decidedBy))
      .limit(1);
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, row.orgId))
      .limit(1);
    if (!approver || !organization) return { status: "invalid_grant" };
    // The approver may have been deactivated or demoted to guest since approving.
    if (approver.deactivatedAt || approver.role === "guest")
      return { status: "access_denied" };

    // The device acts for the approver, who can create agents (guests can't approve).
    const ctx: ActorContext = {
      orgId: organization.id,
      actorId: approver.id,
      role: approver.role,
      source: "cli",
    };
    const name = `spider CLI · ${row.clientName}`;
    const baseHandle = `cli-${handleFrom(row.clientName)}`.slice(0, 28);

    // Reuse this person's agent for the same device name, or create one with a free handle.
    const [existing] = await tx
      .select({ actor: actors })
      .from(agents)
      .innerJoin(actors, eq(agents.actorId, actors.id))
      .where(
        and(
          eq(actors.orgId, organization.id),
          eq(agents.ownerId, approver.id),
          eq(actors.name, name),
          isNull(actors.deactivatedAt),
        ),
      )
      .limit(1);

    let agent = existing?.actor;
    if (!agent) {
      const taken = new Set(
        (
          await tx
            .select({ handle: actors.handle })
            .from(actors)
            .where(
              and(
                eq(actors.orgId, organization.id),
                like(actors.handle, `${baseHandle}%`),
              ),
            )
        ).map((r) => r.handle),
      );
      let handle = baseHandle;
      for (let n = 2; taken.has(handle); n++) handle = `${baseHandle}-${n}`;
      [agent] = await tx
        .insert(actors)
        .values({
          orgId: organization.id,
          type: "agent",
          name,
          handle,
          role: "member",
        })
        .returning();
      if (!agent) throw new Error("Failed to create device agent");
      await tx.insert(agents).values({
        actorId: agent.id,
        ownerId: approver.id,
        description: "Signed in with spider login",
      });
      await recordActivity(tx, ctx, {
        entityType: "actor",
        entityId: agent.id,
        action: "agent.created",
        changes: { name, handle },
      });
    }

    const { secret } = await issueApiKey(
      tx,
      ctx,
      agent.id,
      `spider login · ${now.toISOString().slice(0, 10)}`,
    );
    await tx
      .update(deviceCodes)
      .set({ status: "consumed" })
      .where(eq(deviceCodes.id, row.id));
    return {
      status: "approved",
      secret,
      actor: agent,
      ownerId: approver.id,
      organization,
    };
  });
}
