import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { authenticateApiKey, createAgent, createApiKey, listAgents, revokeApiKey } from "./agents";
import { createOrganization } from "./organizations";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("agents and API keys", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Owner", email: "owner@example.com" };
  const slug = `agents-${Date.now()}`;
  let ctx: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
    const { organization, actor } = await createOrganization(db, user, { name: "Agents Org", slug });
    ctx = { orgId: organization.id, actorId: actor.id, role: "owner", source: "ui" };
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
    await db.$client.end();
  });

  test("creates an agent owned by the creator, with a unique handle", async () => {
    const { actor: agent } = await createAgent(db, ctx, { name: "Claude Code" });
    expect(agent).toMatchObject({ type: "agent", handle: "claude-code", role: "member" });
    await expect(createAgent(db, ctx, { name: "Claude Code" })).rejects.toMatchObject({ code: "conflict" });
    await expect(createAgent(db, { ...ctx, role: "member" }, { name: "Nope" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("issues a key that authenticates as the agent until revoked", async () => {
    const [agent] = await listAgents(db, ctx.orgId);
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
    const [after] = await listAgents(db, ctx.orgId);
    expect(after?.keys[0]?.revokedAt).not.toBeNull();
  });
});
