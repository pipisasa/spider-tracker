import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDb, schema } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { authenticateApiKey } from "./agents";
import {
  decideDevice,
  normalizeUserCode,
  pollDeviceToken,
  startDeviceAuthorization,
} from "./devices";
import { createOrganization } from "./organizations";

describe("normalizeUserCode", () => {
  test("accepts spacing and case variations", () => {
    expect(normalizeUserCode("wdjb mjht")).toBe("WDJB-MJHT");
    expect(normalizeUserCode("WDJBMJHT")).toBe("WDJB-MJHT");
    expect(normalizeUserCode("WDJB")).toBeNull();
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("device authorization", () => {
  const db = createDb(url ?? "");
  const user = {
    id: `test-${crypto.randomUUID()}`,
    name: "Owner",
    email: "owner@example.com",
  };
  const slug = `devices-${Date.now()}`;
  let orgId = "";
  const people: string[] = [];

  /** Adds a person to the organization with a role; returns their user id and actor id. */
  async function addPerson(role: "member" | "guest", handle: string) {
    const id = `test-${crypto.randomUUID()}`;
    people.push(id);
    await db
      .insert(schema.user)
      .values({ id, name: handle, email: `${id}@example.com` });
    const [actor] = await db
      .insert(schema.actors)
      .values({ orgId, type: "human", userId: id, name: handle, handle, role })
      .returning();
    if (!actor) throw new Error("Failed to add person");
    return { userId: id, actorId: actor.id };
  }

  const statusOf = async (userCode: string) =>
    (
      await db
        .select()
        .from(schema.deviceCodes)
        .where(eq(schema.deviceCodes.userCode, userCode))
    )[0]?.status;

  // Polls are rate-limited per device code; pretend this code's previous poll was long ago.
  // (Scoped to the code: other packages' tests share the database and run in parallel.)
  const poll = async (deviceCode: string) => {
    await db
      .update(schema.deviceCodes)
      .set({ lastPolledAt: null })
      .where(
        eq(
          schema.deviceCodes.deviceCodeHash,
          createHash("sha256").update(deviceCode).digest("hex"),
        ),
      );
    return pollDeviceToken(db, deviceCode);
  };

  beforeAll(async () => {
    await db.insert(schema.user).values({
      id: user.id,
      name: user.name,
      email: `${user.id}@example.com`,
    });
    const { organization } = await createOrganization(db, user, {
      name: "Devices Org",
      slug,
    });
    orgId = organization.id;
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    for (const id of [user.id, ...people])
      await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("pending → approved → key for a device agent, reused on the next login", async () => {
    const first = await startDeviceAuthorization(db, {
      client_name: "MacBook",
    });
    expect(first.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect((await poll(first.deviceCode)).status).toBe("authorization_pending");

    await decideDevice(db, user.id, first.userCode.toLowerCase(), {
      approve: true,
      orgSlug: slug,
    });
    const approved = await poll(first.deviceCode);
    if (approved.status !== "approved")
      throw new Error(`expected approval, got ${approved.status}`);
    expect(approved.actor).toMatchObject({
      type: "agent",
      name: "spider CLI · MacBook",
      handle: "cli-macbook",
      role: "member",
    });
    expect((await authenticateApiKey(db, approved.secret))?.actor.id).toBe(
      approved.actor.id,
    );

    // The code is single-use.
    expect((await poll(first.deviceCode)).status).toBe("invalid_grant");
    await expect(
      decideDevice(db, user.id, first.userCode, { approve: false }),
    ).rejects.toMatchObject({ code: "conflict" });

    const second = await startDeviceAuthorization(db, {
      client_name: "MacBook",
    });
    await decideDevice(db, user.id, second.userCode, {
      approve: true,
      orgSlug: slug,
    });
    const again = await poll(second.deviceCode);
    if (again.status !== "approved") throw new Error("expected approval");
    expect(again.actor.id).toBe(approved.actor.id);
  });

  test("denied, expired, too-fast polling and other people's organizations", async () => {
    const denied = await startDeviceAuthorization(db, {
      client_name: "Laptop",
    });
    await decideDevice(db, user.id, denied.userCode, { approve: false });
    expect((await poll(denied.deviceCode)).status).toBe("access_denied");

    const fast = await startDeviceAuthorization(db, {});
    expect((await pollDeviceToken(db, fast.deviceCode)).status).toBe(
      "authorization_pending",
    );
    expect((await pollDeviceToken(db, fast.deviceCode)).status).toBe(
      "slow_down",
    );

    await expect(
      decideDevice(db, user.id, fast.userCode, {
        approve: true,
        orgSlug: "not-mine",
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });

    await db
      .update(schema.deviceCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.deviceCodes.userCode, fast.userCode));
    expect((await poll(fast.deviceCode)).status).toBe("expired_token");
    expect((await pollDeviceToken(db, "unknown")).status).toBe("invalid_grant");
  });

  test("guests can't approve; a demoted approver gets access_denied and no key", async () => {
    const guest = await addPerson("guest", "device-guest");
    const code = await startDeviceAuthorization(db, {
      client_name: "Guest Laptop",
    });
    await expect(
      decideDevice(db, guest.userId, code.userCode, {
        approve: true,
        orgSlug: slug,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await statusOf(code.userCode)).toBe("pending");

    const member = await addPerson("member", "device-member");
    const later = await startDeviceAuthorization(db, {
      client_name: "Member Laptop",
    });
    await decideDevice(db, member.userId, later.userCode, {
      approve: true,
      orgSlug: slug,
    });
    await db
      .update(schema.actors)
      .set({ role: "guest" })
      .where(eq(schema.actors.id, member.actorId));
    expect((await poll(later.deviceCode)).status).toBe("access_denied");
    const created = await db
      .select()
      .from(schema.agents)
      .innerJoin(schema.actors, eq(schema.agents.actorId, schema.actors.id))
      .where(
        and(
          eq(schema.actors.orgId, orgId),
          eq(schema.agents.ownerId, member.actorId),
        ),
      );
    expect(created).toHaveLength(0);
  });

  test("an already decided code can't be approved or denied again", async () => {
    const approved = await startDeviceAuthorization(db, {
      client_name: "Twice",
    });
    await decideDevice(db, user.id, approved.userCode, {
      approve: true,
      orgSlug: slug,
    });
    await expect(
      decideDevice(db, user.id, approved.userCode, {
        approve: true,
        orgSlug: slug,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      decideDevice(db, user.id, approved.userCode, { approve: false }),
    ).rejects.toMatchObject({
      code: "conflict",
    });

    const denied = await startDeviceAuthorization(db, { client_name: "Twice" });
    await decideDevice(db, user.id, denied.userCode, { approve: false });
    await expect(
      decideDevice(db, user.id, denied.userCode, { approve: false }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      decideDevice(db, user.id, denied.userCode, {
        approve: true,
        orgSlug: slug,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await statusOf(denied.userCode)).toBe("denied");

    // Concurrent decisions both pass the status check; only one may win.
    const raced = await startDeviceAuthorization(db, { client_name: "Raced" });
    const results = await Promise.allSettled([
      decideDevice(db, user.id, raced.userCode, {
        approve: true,
        orgSlug: slug,
      }),
      decideDevice(db, user.id, raced.userCode, { approve: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  test("starting a login purges codes that expired over a day ago", async () => {
    const old = await startDeviceAuthorization(db, { client_name: "Old" });
    await db
      .update(schema.deviceCodes)
      .set({ expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.deviceCodes.userCode, old.userCode));
    await startDeviceAuthorization(db, { client_name: "New" });
    expect(await statusOf(old.userCode)).toBeUndefined();
  });
});
