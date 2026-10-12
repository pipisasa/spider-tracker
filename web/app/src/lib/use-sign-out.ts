import { authClient } from "@/lib/auth-client";
import { meQuery } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

/** Signs out, drops every cached query (they belong to the old user) and goes to the login page. */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await authClient.signOut();
    queryClient.clear();
    queryClient.setQueryData(meQuery.queryKey, null);
    await navigate({ to: "/login" });
  };
}
