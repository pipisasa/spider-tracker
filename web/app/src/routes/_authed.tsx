import { meQuery } from "@/lib/queries";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

// Layout route: everything under it requires a signed-in user.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login" });
    return { me };
  },
  component: Outlet,
});
