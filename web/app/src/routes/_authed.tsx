import { CommandPalette } from "@/components/command-palette";
import { meQuery } from "@/lib/queries";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

// Layout route: everything under it requires a signed-in user.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    // Come back here after signing in (e.g. the /device approval page).
    if (!me)
      throw redirect({ to: "/login", search: { redirect: location.href } });
    return { me };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { me } = Route.useRouteContext();
  return (
    <>
      <Outlet />
      <CommandPalette me={me} />
    </>
  );
}
