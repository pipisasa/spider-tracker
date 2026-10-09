import type { MeResponse, MembershipDto } from "@repo/core/contracts";
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
  return api<MembershipDto>("/v1/organizations", { method: "POST", body: JSON.stringify(input) });
}
