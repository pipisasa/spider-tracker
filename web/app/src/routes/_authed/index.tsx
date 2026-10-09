import { createFileRoute, redirect } from "@tanstack/react-router";

// Entry point: go to the first organization, or create one.
export const Route = createFileRoute("/_authed/")({
  beforeLoad: ({ context }) => {
    const first = context.me.memberships[0];
    if (!first) throw redirect({ to: "/onboarding" });
    throw redirect({ to: "/$orgSlug", params: { orgSlug: first.organization.slug } });
  },
});
