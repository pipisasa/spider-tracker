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
import { useOrgEvents } from "@/lib/realtime";
import { membersQuery, projectsQuery } from "@/lib/work";
import { useSignOut } from "@/lib/use-sign-out";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  FolderIcon,
  LayoutGridIcon,
  LogInIcon,
  LogOutIcon,
  PlusIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
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
  useOrgEvents(orgSlug);
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const canCreateAgents = membership.actor.role !== "guest";

  const signOut = useSignOut();

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
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/">
                <LayoutGridIcon />
                All organizations
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/onboarding">
                <PlusIcon />
                New organization
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/" search={{ join: "" }}>
                <LogInIcon />
                Join organization
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
          <Link
            to="/$orgSlug/docs"
            params={{ orgSlug }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            activeProps={{ className: "bg-muted font-medium" }}
          >
            <FileTextIcon className="size-4 text-muted-foreground" />
            Docs
          </Link>
        </nav>

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

        <nav className="flex flex-col gap-1">
          <span className="px-2 text-xs font-medium text-muted-foreground">Settings</span>
          <Link
            to="/$orgSlug/settings/members"
            params={{ orgSlug }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            activeProps={{ className: "bg-muted font-medium" }}
          >
            <UsersIcon className="size-4 text-muted-foreground" />
            Members
          </Link>
          {canCreateAgents && (
            <Link
              to="/$orgSlug/settings/agents"
              params={{ orgSlug }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              activeProps={{ className: "bg-muted font-medium" }}
            >
              <BotIcon className="size-4 text-muted-foreground" />
              Agents
            </Link>
          )}
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
