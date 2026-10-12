import { NewProjectDialog } from "@/components/new-project-dialog";
import { ThemeMenuItems } from "@/components/theme-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { paletteHint } from "@/components/command-palette";
import { Toaster } from "@/components/ui/sonner";
import { openPalette } from "@/lib/app-events";
import { useOrgEvents } from "@/lib/realtime";
import { actorsQuery, membersQuery, projectsQuery } from "@/lib/work";
import { useSignOut } from "@/lib/use-sign-out";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  FolderIcon,
  FolderCogIcon,
  LayoutGridIcon,
  LogInIcon,
  LogOutIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
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
      context.queryClient.prefetchQuery(actorsQuery(params.orgSlug)),
    ]);
  },
  component: OrgLayout,
});

function OrgLayout() {
  const { orgSlug } = Route.useParams();
  const { membership, me } = Route.useRouteContext();
  const { data: projects = [] } = useQuery(projectsQuery(orgSlug));
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useOrgEvents(orgSlug);
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const canCreateAgents = membership.actor.role !== "guest";

  const signOut = useSignOut();

  const sidebar = (
    <>
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
            <DropdownMenuSeparator />
            <ThemeMenuItems />
            <DropdownMenuItem onSelect={signOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          className="justify-start gap-2 px-2 font-normal text-muted-foreground"
          onClick={openPalette}
        >
          <SearchIcon className="size-4" />
          Search…
          <kbd className="ml-auto hidden rounded border bg-muted px-1.5 font-mono text-xs md:inline">{paletteHint()}</kbd>
        </Button>

        <nav className="flex flex-col gap-1">
          <Link
            to="/$orgSlug/docs"
            params={{ orgSlug }}
            className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-muted md:py-1.5"
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
              className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-muted md:py-1.5"
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
            className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-muted md:py-1.5"
            activeProps={{ className: "bg-muted font-medium" }}
          >
            <UsersIcon className="size-4 text-muted-foreground" />
            Members
          </Link>
          {canManage && (
            <Link
              to="/$orgSlug/settings/projects"
              params={{ orgSlug }}
              className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-muted md:py-1.5"
              activeProps={{ className: "bg-muted font-medium" }}
            >
              <FolderCogIcon className="size-4 text-muted-foreground" />
              Projects
            </Link>
          )}
          {canCreateAgents && (
            <Link
              to="/$orgSlug/settings/agents"
              params={{ orgSlug }}
              className="flex items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-muted md:py-1.5"
              activeProps={{ className: "bg-muted font-medium" }}
            >
              <BotIcon className="size-4 text-muted-foreground" />
              Agents
            </Link>
          )}
        </nav>

        <div className="mt-auto truncate px-2 text-xs text-muted-foreground">{me.user.email}</div>
    </>
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden md:flex-row">
      <header className="z-30 flex shrink-0 items-center gap-2 border-b bg-background px-2 pt-[env(safe-area-inset-top)] md:hidden">
        <Button variant="ghost" size="icon" className="size-10" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <MenuIcon className="size-5" />
        </Button>
        <span className="truncate font-semibold">{membership.organization.name}</span>
      </header>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-72 p-0 md:hidden" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <div
            className="flex h-full flex-col gap-4 overflow-y-auto p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            onClick={(e) => {
              if (e.target instanceof Element && e.target.closest("a")) setMenuOpen(false);
            }}
          >
            {sidebar}
          </div>
        </SheetContent>
      </Sheet>
      <aside className="hidden h-full w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-muted/30 p-3 md:flex">
        {sidebar}
      </aside>

      <div id="org-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>

      <NewProjectDialog orgSlug={orgSlug} open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      <Toaster />
    </div>
  );
}
