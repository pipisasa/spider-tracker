import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, getTableColumns, isNull, ne } from "drizzle-orm";
import { DomainError } from "./errors";
import { handleFrom } from "./handles";
import { createOrganizationInput } from "./schemas";

const { actors, agents, organizations } = schema;

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

/**
 * Active members (people and agents) of an organization. `includeDeactivated` adds
 * deactivated ones and integration bots, so tasks and activity can show who they were.
 * `ownerId` is the owning person's actor id for agents, null for people.
 */
export async function listMembers(db: Db, orgId: string, opts: { includeDeactivated?: boolean } = {}) {
  return db
    .select({ ...getTableColumns(actors), ownerId: agents.ownerId })
    .from(actors)
    .leftJoin(agents, eq(agents.actorId, actors.id))
    // Integration bots (the GitHub one, ST-82) are listed only with the deactivated: never in pickers.
    .where(
      opts.includeDeactivated
        ? eq(actors.orgId, orgId)
        : and(eq(actors.orgId, orgId), isNull(actors.deactivatedAt), ne(actors.type, "integration")),
    )
    .orderBy(actors.name);
}
