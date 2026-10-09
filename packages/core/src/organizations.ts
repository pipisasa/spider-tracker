import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, isNull } from "drizzle-orm";
import { DomainError } from "./errors";
import { handleFrom } from "./handles";
import { createOrganizationInput } from "./schemas";

const { actors, organizations } = schema;

export interface UserIdentity {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/** Creates an organization with the user as its owner actor. */
export async function createOrganization(db: Db, user: UserIdentity, input: unknown) {
  const parsed = createOrganizationInput.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { name, slug } = parsed.data;

  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name, slug })
      .onConflictDoNothing({ target: organizations.slug })
      .returning();
    if (!organization) throw new DomainError("conflict", `Slug "${slug}" is taken`);

    const [actor] = await tx
      .insert(actors)
      .values({
        orgId: organization.id,
        type: "human",
        userId: user.id,
        name: user.name || user.email,
        handle: handleFrom(user.email),
        avatarUrl: user.image ?? null,
        role: "owner",
      })
      .returning();
    if (!actor) throw new Error("Failed to create owner actor");

    return { organization, actor };
  });
}

/** Organizations the user belongs to, with their actor in each. */
export async function listMemberships(db: Db, userId: string) {
  return db
    .select({
      organization: organizations,
      actor: actors,
    })
    .from(actors)
    .innerJoin(organizations, eq(actors.orgId, organizations.id))
    .where(and(eq(actors.userId, userId), isNull(actors.deactivatedAt)))
    .orderBy(organizations.createdAt);
}
