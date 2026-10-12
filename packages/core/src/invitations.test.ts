import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { ActorContext } from "./access";
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  normalizeInvitationCode,
  previewInvitation,
  revokeInvitation,
} from "./invitations";
import { createOrganization, listMemberships } from "./organizations";
import { holdLock, settle, waitForLockWaiters } from "./test-locks";

// Integration test: needs a migrated database in TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

test("normalizes typed codes", () => {
  expect(normalizeInvitationCode(" abcd-efgh ")).toBe("ABCDEFGH");
  expect(normalizeInvitationCode("ab cd ef gh")).toBe("ABCDEFGH");
});

run("invitations", () => {
  const db = createDb(url ?? "");
  const stamp = Date.now();
  const slug = `inv-${stamp}`;
  const user = (name: string) => ({
    id: `test-${crypto.randomUUID()}`,
    name,
    email: `${name.toLowerCase()}@example.com`,
  });
  const owner = user("Owner");
  const joiner = user("Sam");
  const twin = { ...user("Sam"), name: "Sam Two" };
  const third = user("Third");
  const racers = [user("Racer"), { ...user("Racer"), name: "Racer Two" }];
  const users = [owner, joiner, twin, third, ...racers];
  let ctx: ActorContext;

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values(
        users.map((u) => ({
          id: u.id,
          name: u.name,
          email: `${u.id}@example.com`,
        })),
      );
    const { organization, actor } = await createOrganization(db, owner, {
      name: "Invite Org",
      slug,
    });
    ctx = {
      orgId: organization.id,
      actorId: actor.id,
      role: "owner",
      source: "ui",
    };
  });

  afterAll(async () => {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(
      inArray(
        schema.user.id,
        users.map((u) => u.id),
      ),
    );
    await db.$client.end();
  });

  test("a member joins with a code and gets a unique handle", async () => {
    const invitation = await createInvitation(db, ctx, { maxUses: 2 });
    expect(invitation).toMatchObject({
      role: "member",
      status: "active",
      useCount: 0,
      maxUses: 2,
    });
    expect(invitation.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const code = invitation.code.replace("-", "").toLowerCase();
    expect(await previewInvitation(db, joiner.id, { code })).toMatchObject({
      organization: { slug },
      role: "member",
      alreadyMember: false,
    });

    const joined = await acceptInvitation(db, joiner, { code });
    expect(joined.actor).toMatchObject({
      role: "member",
      handle: "sam",
      type: "human",
    });
    expect(
      (await listMemberships(db, joiner.id)).map((m) => m.organization.slug),
    ).toContain(slug);

    await expect(acceptInvitation(db, joiner, { code })).rejects.toMatchObject({
      code: "conflict",
    });

    const second = await acceptInvitation(db, twin, { code });
    expect(second.actor.handle).toBe("sam-2");

    // Two uses, two joins: the code is used up.
    await expect(acceptInvitation(db, third, { code })).rejects.toMatchObject({
      code: "validation",
      message: "Invalid or expired invitation code",
    });
    const [listed] = await listInvitations(db, ctx);
    expect(listed).toMatchObject({
      id: invitation.id,
      useCount: 2,
      status: "used_up",
    });
  });

  test("two people with the same handle joining at once get distinct handles", async () => {
    const codes = await Promise.all([createInvitation(db, ctx, {}), createInvitation(db, ctx, {})]);
    // Both pick "racer", then queue on the foreign-key check of the locked organization.
    const release = await holdLock(db, sql`select 1 from organizations where id = ${ctx.orgId} for update`);
    const joining = Promise.all(racers.map((racer, i) => acceptInvitation(db, racer, { code: codes[i]?.code ?? "" })));
    const settled = settle(joining);
    await waitForLockWaiters(db, "actors", 2);
    await release();
    expect(await settled).toBeNull();
    expect((await joining).map((j) => j.actor.handle).sort()).toEqual(["racer", "racer-2"]);
  });

  test("malformed invitation ids are not found", async () => {
    await expect(revokeInvitation(db, ctx, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
  });

  test("revoked, expired and unknown codes are refused alike", async () => {
    const revoked = await createInvitation(db, ctx, {});
    await revokeInvitation(db, ctx, revoked.id);
    await expect(
      acceptInvitation(db, third, { code: revoked.code }),
    ).rejects.toMatchObject({ code: "validation" });

    const expired = await createInvitation(db, ctx, {});
    await db
      .update(schema.invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitations.id, expired.id));
    await expect(
      acceptInvitation(db, third, { code: expired.code }),
    ).rejects.toMatchObject({ code: "validation" });

    await expect(
      acceptInvitation(db, third, { code: "ZZZZ-ZZZZ" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  test("only owners and admins invite; only owners invite admins", async () => {
    const [member] = await db
      .select()
      .from(schema.actors)
      .where(eq(schema.actors.userId, joiner.id));
    const asMember: ActorContext = {
      ...ctx,
      actorId: member?.id ?? "",
      role: "member",
    };
    await expect(createInvitation(db, asMember, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      createInvitation(db, { ...ctx, role: "admin" }, { role: "admin" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      createInvitation(db, ctx, { role: "owner" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      createInvitation(db, ctx, { expiresInDays: 31 }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(
      (await createInvitation(db, ctx, { role: "admin", expiresInDays: 1 }))
        .role,
    ).toBe("admin");
  });
});
