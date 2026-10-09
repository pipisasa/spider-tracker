import { NewProjectDialog } from "@/components/new-project-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { authClient } from "@/lib/auth-client";
import { meQuery } from "@/lib/queries";
import { membersQuery, projectsQuery } from "@/lib/work";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, FolderIcon, LogOutIcon, PlusIcon, UserIcon } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/_authed/$orgSlug")({
  beforeLoad: ({ context, params }) => {
    const membership = context.me.memberships.find((m) => m.organization.slug === params.orgSlug);
    if (!membership) throw notFound();
    return { membership };
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(projectsQuery(params.orgSlug)),
      context.queryClient.prefetchQuery(membersQuery(params.orgSlug)),
    ]);
  },
  component: OrgLayout,
});

function OrgLayout() {
  const { orgSlug } = Route.useParams();
  const { membership, me } = Route.useRouteContext();
  const { data: projects = [] } = useQuery(projectsQuery(orgSlug));
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    queryClient.setQueryData(meQuery.queryKey, null);
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex min-h-svh">
      <aside className="flex w-60 shrink-0 flex-col gap-4 border-r bg-muted/30 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="justify-between px-2 font-semibold">
              <span className="truncate">{membership.organization.name}</span>
              <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {me.memberships.map(({ organization }) => (
              <DropdownMenuItem key={organization.id} asChild>
                <Link to="/$orgSlug" params={{ orgSlug: organization.slug }}>
                  {organization.name}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem asChild>
              <Link to="/onboarding">
                <PlusIcon />
                New organization
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/account">
                <UserIcon />
                Account
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={signOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <nav className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
            Projects
            {canManage && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="New project"
                onClick={() => setNewProjectOpen(true)}
              >
                <PlusIcon className="size-4" />
              </Button>
            )}
          </div>
          {projects.map((p) => (
            <Link
              key={p.id}
              to="/$orgSlug/projects/$projectKey"
              params={{ orgSlug, projectKey: p.key }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              activeProps={{ className: "bg-muted font-medium" }}
            >
              <FolderIcon className="size-4 text-muted-foreground" />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{p.key}</span>
            </Link>
          ))}
          {projects.length === 0 && <p className="px-2 text-sm text-muted-foreground">No projects yet.</p>}
        </nav>

        <div className="mt-auto truncate px-2 text-xs text-muted-foreground">{me.user.email}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>

      <NewProjectDialog orgSlug={orgSlug} open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      <Toaster />
    </div>
  );
}
