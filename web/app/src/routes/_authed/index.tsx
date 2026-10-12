import { JoinOrganizationForm } from "@/components/join-organization";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Building2Icon, ChevronRightIcon, PlusIcon } from "lucide-react";

// Entry point after sign-in: the user's organizations, or how to get into one.
// `?join=CODE` prefills the invitation code (links copied from Members settings); `?join` alone focuses the field.
export const Route = createFileRoute("/_authed/")({
  validateSearch: (search: Record<string, unknown>): { join?: string } => {
    const { join } = search;
    if (join === undefined) return {};
    // All-digit codes arrive parsed as numbers.
    return {
      join:
        typeof join === "string" || typeof join === "number"
          ? String(join)
          : "",
    };
  },
  component: OrganizationsPage,
});

function OrganizationsPage() {
  const { me } = Route.useRouteContext();
  const { join } = Route.useSearch();
  const memberships = me.memberships;

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col gap-6 px-4 py-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Your organizations</h1>
        {memberships.length > 0 && (
          <Button asChild variant="outline" size="sm">
            <Link to="/onboarding">
              <PlusIcon />
              Create organization
            </Link>
          </Button>
        )}
      </header>

      {memberships.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {memberships.map(({ organization, actor }) => (
            <li key={organization.id}>
              <Link
                to="/$orgSlug"
                params={{ orgSlug: organization.slug }}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <Building2Icon className="size-5 text-muted-foreground" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {organization.name}
                  </span>
                  <span className="truncate text-sm text-muted-foreground">
                    {organization.slug}
                  </span>
                </div>
                <Badge variant="secondary" className="ml-auto capitalize">
                  {actor.role}
                </Badge>
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>You have no organizations</CardTitle>
            <CardDescription>
              Projects, tasks and agents live inside an organization. Create
              your own, or join one with an invitation code from its owner or an
              admin.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/onboarding">
                <PlusIcon />
                Create organization
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Join via invitation code</CardTitle>
          <CardDescription>
            Codes look like ABCD-EFGH; dashes and case don't matter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <JoinOrganizationForm
            initialCode={join}
            autoFocus={join !== undefined}
          />
        </CardContent>
      </Card>
    </main>
  );
}
