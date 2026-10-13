import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <div className="min-h-svh bg-background text-foreground">
      <Outlet />
    </div>
  ),
  notFoundComponent: () => (
    <p className="p-8 text-sm text-muted-foreground">Page not found.</p>
  ),
});
