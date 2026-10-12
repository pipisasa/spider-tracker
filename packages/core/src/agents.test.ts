import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import {
  authenticateApiKey,
  createAgent,
  createApiKey,
  deleteAgent,
  listAgents,
  revokeApiKey,
  updateAgent,
} from "./agents";
import { createOrganization } from "./organizations";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("agents and API keys", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `agents-${Date.now()}`;
  let ctx: ActorContext;
  const people: string[] = [];

  /** Adds a person with a role and returns their context. */
  async function addPerson(role: ActorContext["role"], handle: string): Promise<ActorContext> {
    const id = `test-${crypto.randomUUID()}`;
    people.push(id);
    await db.insert(schema.user).values({ id, name: handle, email: `${id}@example.com` });
    const [actor] = await db
      .insert(schema.actors)
      .values({ orgId: ctx.orgId, type: "human", userId: id, name: handle, handle, role })
      .returning();
    return { orgId: ctx.orgId, actorId: actor?.id ?? "", role, source: "ui" };
  }

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Agents Org", slug });
    ctx = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const id of [user.id, ...people]) await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("creates an agent owned by the creator, with a unique handle", async () => {
    const { actor: agent } = await createAgent(db, ctx, { name: "Claude Code" });
    expect(agent).toMatchObject({ type: "agent", handle: "claude-code", role: "member" });
    await expect(createAgent(db, ctx, { name: "Claude Code" })).rejects.toMatchObject({ code: "conflict" });
    await expect(createAgent(db, { ...ctx, role: "guest" }, { name: "Nope" })).rejects.toMatchObject({
      code: "forbidden",
    });
    // An agent acting with its own key can't create agents, even with a member role.
    await expect(createAgent(db, { ...ctx, actorId: agent.id, role: "member" }, { name: "Nope" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("issues a key that authenticates as the agent until revoked", async () => {
    const [agent] = await listAgents(db, ctx);
    const created = await createApiKey(db, ctx, agent?.actor.id ?? "", { name: "laptop" });
    expect(created.secret).toStartWith("spt_");
    expect(created.secret.startsWith(created.key.prefix)).toBe(true);

    const stored = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, created.key.id));
    expect(stored[0]?.tokenHash).not.toContain(created.secret);

    const auth = await authenticateApiKey(db, created.secret);
    expect(auth?.actor.id).toBe(agent?.actor.id ?? "");
    expect(auth?.organization.id).toBe(ctx.orgId);
    expect(await authenticateApiKey(db, `${created.secret}x`)).toBeNull();
    expect(await authenticateApiKey(db, "not-a-key")).toBeNull();

    await revokeApiKey(db, ctx, created.key.id);
    expect(await authenticateApiKey(db, created.secret)).toBeNull();
    const [after] = await listAgents(db, ctx);
    expect(after?.keys[0]?.revokedAt).not.toBeNull();
  });

  test("members create and manage their own agents; admins manage all", async () => {
    const alice = await addPerson("member", `alice-${Date.now()}`);
    const bob = await addPerson("member", `bob-${Date.now()}`);
    const admin = await addPerson("admin", `admin-${Date.now()}`);

    const created = await createAgent(db, alice, { name: "Alice Bot", description: "helps" });
    const agentId = created.actor.id;
    expect(created).toMatchObject({ ownerId: alice.actorId, canManage: true, actor: { role: "member" } });

    const key = await createApiKey(db, alice, agentId, { name: "laptop" });
    await expect(createApiKey(db, bob, agentId, { name: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeApiKey(db, bob, key.key.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateAgent(db, bob, agentId, { name: "Mine" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteAgent(db, bob, agentId)).rejects.toMatchObject({ code: "forbidden" });

    const seenByBob = (await listAgents(db, bob)).find((a) => a.actor.id === agentId);
    expect(seenByBob).toMatchObject({ canManage: false, keys: [], owner: { id: alice.actorId } });
    const seenByAlice = (await listAgents(db, alice)).find((a) => a.actor.id === agentId);
    expect(seenByAlice?.canManage).toBe(true);
    expect(seenByAlice?.keys.map((k) => k.id)).toEqual([key.key.id]);

    const updated = await updateAgent(db, admin, agentId, { name: "Renamed", handle: "renamed-bot", description: null });
    expect(updated).toMatchObject({ actor: { name: "Renamed", handle: "renamed-bot" }, description: null });
    await expect(updateAgent(db, alice, agentId, { handle: "claude-code" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(updateAgent(db, alice, agentId, { handle: "Not Valid!" })).rejects.toMatchObject({
      code: "validation",
    });

    await deleteAgent(db, alice, agentId);
    expect(await authenticateApiKey(db, key.secret)).toBeNull();
    expect((await listAgents(db, admin)).some((a) => a.actor.id === agentId)).toBe(false);
    await expect(updateAgent(db, alice, agentId, { name: "Back" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("an agent's keys stop working when its owner is deactivated", async () => {
    const carol = await addPerson("member", `carol-${Date.now()}`);
    const { actor } = await createAgent(db, carol, { name: "Carol Bot" });
    const { secret } = await createApiKey(db, carol, actor.id, { name: "k" });
    expect(await authenticateApiKey(db, secret)).not.toBeNull();
    await db.update(schema.actors).set({ deactivatedAt: new Date() }).where(eq(schema.actors.id, carol.actorId));
    expect(await authenticateApiKey(db, secret)).toBeNull();
  });
});
