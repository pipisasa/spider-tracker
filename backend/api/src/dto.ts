import type { ActorDto, MembershipDto } from "@repo/core";
import type { schema } from "@repo/db";

type ActorRow = typeof schema.actors.$inferSelect;
type OrganizationRow = typeof schema.organizations.$inferSelect;

export function toActorDto(actor: ActorRow, ownerId: string | null): ActorDto {
  return {
    id: actor.id,
    type: actor.type,
    name: actor.name,
    handle: actor.handle,
    avatarUrl: actor.avatarUrl,
    role: actor.role,
    deactivated: actor.deactivatedAt !== null,
    ownerId,
  };
}

export function toMembership({
  organization,
  actor,
  ownerId = null,
}: {
  organization: OrganizationRow;
  actor: ActorRow;
  ownerId?: string | null;
}): MembershipDto {
  return {
    organization: { id: organization.id, slug: organization.slug, name: organization.name },
    actor: toActorDto(actor, ownerId),
  };
}
