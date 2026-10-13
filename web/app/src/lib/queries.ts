import type {
  AuthProvidersResponse,
  InvitationPreviewDto,
  MeResponse,
  MembershipDto,
} from "@repo/core/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, api } from "./api";

/** The signed-in user and their organizations, or null when signed out. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<MeResponse | null> => {
    try {
      return await api<MeResponse>("/v1/me");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 60_000,
});

export function createOrganization(input: { name: string; slug: string }) {
  return api<MembershipDto>("/v1/organizations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function previewInvitation(code: string) {
  return api<InvitationPreviewDto>("/v1/invitations/preview", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function acceptInvitation(code: string) {
  return api<MembershipDto>("/v1/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/** Sign-in methods the API has configured. */
export const authProvidersQuery = queryOptions({
  queryKey: ["auth-providers"],
  queryFn: () => api<AuthProvidersResponse>("/auth/providers"),
  staleTime: Infinity,
});
