// Response shapes of the public API, shared with clients.

export type ActorRole = "owner" | "admin" | "member" | "guest";

export interface OrganizationDto {
  id: string;
  slug: string;
  name: string;
}

export interface ActorDto {
  id: string;
  type: "human" | "agent";
  name: string;
  handle: string;
  avatarUrl: string | null;
  role: ActorRole;
}

export interface MembershipDto {
  organization: OrganizationDto;
  actor: ActorDto;
}

export interface MeResponse {
  user: { id: string; name: string; email: string; image: string | null };
  memberships: MembershipDto[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
