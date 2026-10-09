import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { authenticateApiKey } from "./agents";
import { decideDevice, normalizeUserCode, pollDeviceToken, startDeviceAuthorization } from "./devices";
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
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `devices-${Date.now()}`;

  // Polls are rate-limited per device code; pretend this code's previous poll was long ago.
  // (Scoped to the code: other packages' tests share the database and run in parallel.)
  const poll = async (deviceCode: string) => {
    await db
      .update(schema.deviceCodes)
      .set({ lastPolledAt: null })
      .where(eq(schema.deviceCodes.deviceCodeHash, createHash("sha256").update(deviceCode).digest("hex")));
    return pollDeviceToken(db, deviceCode);
  };

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    await createOrganization(db, user, { name: "Devices Org", slug });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("pending → approved → key for a device agent, reused on the next login", async () => {
    const first = await startDeviceAuthorization(db, { client_name: "MacBook" });
    expect(first.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect((await poll(first.deviceCode)).status).toBe("authorization_pending");

    await decideDevice(db, user.id, first.userCode.toLowerCase(), { approve: true, orgSlug: slug });
    const approved = await poll(first.deviceCode);
    if (approved.status !== "approved") throw new Error(`expected approval, got ${approved.status}`);
    expect(approved.actor).toMatchObject({ type: "agent", name: "spider CLI · MacBook", handle: "cli-macbook", role: "member" });
    expect((await authenticateApiKey(db, approved.secret))?.actor.id).toBe(approved.actor.id);

    // The code is single-use.
    expect((await poll(first.deviceCode)).status).toBe("invalid_grant");
    await expect(decideDevice(db, user.id, first.userCode, { approve: false })).rejects.toMatchObject({ code: "conflict" });

    const second = await startDeviceAuthorization(db, { client_name: "MacBook" });
    await decideDevice(db, user.id, second.userCode, { approve: true, orgSlug: slug });
    const again = await poll(second.deviceCode);
    if (again.status !== "approved") throw new Error("expected approval");
    expect(again.actor.id).toBe(approved.actor.id);
  });

  test("denied, expired, too-fast polling and other people's organizations", async () => {
    const denied = await startDeviceAuthorization(db, { client_name: "Laptop" });
    await decideDevice(db, user.id, denied.userCode, { approve: false });
    expect((await poll(denied.deviceCode)).status).toBe("access_denied");

    const fast = await startDeviceAuthorization(db, {});
    expect((await pollDeviceToken(db, fast.deviceCode)).status).toBe("authorization_pending");
    expect((await pollDeviceToken(db, fast.deviceCode)).status).toBe("slow_down");

    await expect(decideDevice(db, user.id, fast.userCode, { approve: true, orgSlug: "not-mine" })).rejects.toMatchObject({
      code: "not_found",
    });

    await db
      .update(schema.deviceCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.deviceCodes.userCode, fast.userCode));
    expect((await poll(fast.deviceCode)).status).toBe("expired_token");
    expect((await pollDeviceToken(db, "unknown")).status).toBe("invalid_grant");
  });
});
