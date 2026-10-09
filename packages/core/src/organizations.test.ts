import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { DomainError } from "./errors";
import { createOrganization, listMemberships } from "./organizations";

// Integration test: needs a migrated database in TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("organizations", () => {
  const db = createDb(url ?? "");
  const user = { id: `test-${crypto.randomUUID()}`, name: "Test User", email: "test.user@example.com" };
  const slug = `test-${Date.now()}`;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: user.id, name: user.name, email: `${user.id}@example.com` });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eqSlug(slug));
    await db.delete(schema.user).where(eqUser(user.id));
    await db.$client.end();
  });

  test("creates an organization with the user as owner", async () => {
    const { organization, actor } = await createOrganization(db, user, { name: "Test Org", slug });
    expect(organization.slug).toBe(slug);
    expect(actor).toMatchObject({ type: "human", role: "owner", userId: user.id, handle: "test-user" });

    const memberships = await listMemberships(db, user.id);
    expect(memberships.map((m) => m.organization.id)).toContain(organization.id);
  });

  test("rejects a taken slug", async () => {
    const attempt = createOrganization(db, user, { name: "Again", slug });
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
  });

  test("rejects an invalid slug", async () => {
    const attempt = createOrganization(db, user, { name: "Bad", slug: "Not A Slug!" });
    await expect(attempt).rejects.toMatchObject({ code: "validation" });
  });
});

const eqSlug = (slug: string) => eq(schema.organizations.slug, slug);
const eqUser = (id: string) => eq(schema.user.id, id);
