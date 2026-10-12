import { ProjectSettingsDialog } from "@/components/project-settings";
import { Button } from "@/components/ui/button";
import {
  archivedProjectsQuery,
  projectsQuery,
  useArchiveProject,
} from "@/lib/work";
import type { ProjectDto } from "@repo/core/contracts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/_authed/$orgSlug/settings/projects")({
  beforeLoad: ({ context, params }) => {
    const role = context.membership.actor.role;
    if (role !== "owner" && role !== "admin")
      throw redirect({ to: "/$orgSlug", params });
  },
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectsQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(archivedProjectsQuery(params.orgSlug)),
    ]),
  component: ProjectsSettingsPage,
});

function ProjectsSettingsPage() {
  const { orgSlug } = Route.useParams();
  const { data: projects } = useSuspenseQuery(projectsQuery(orgSlug));
  const { data: archived } = useSuspenseQuery(archivedProjectsQuery(orgSlug));
  const [editing, setEditing] = useState<ProjectDto | null>(null);
  const restore = useArchiveProject(orgSlug);

  return (
    <>
      <header className="border-b px-6 py-3">
        <h1 className="font-semibold">Projects</h1>
      </header>
      <main className="flex max-w-2xl flex-col gap-6 px-6 py-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Active projects</h2>
          {projects.length === 0 && (
            <p className="text-sm text-muted-foreground">No projects yet.</p>
          )}
          {projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <Link
                to="/$orgSlug/projects/$projectKey"
                params={{ orgSlug, projectKey: p.key }}
                className="truncate text-sm hover:underline"
              >
                {p.name}
              </Link>
              <span className="text-xs text-muted-foreground">{p.key}</span>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setEditing(p)}>
                Settings
              </Button>
            </div>
          ))}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Archived projects</h2>
          {archived.length === 0 && (
            <p className="text-sm text-muted-foreground">No archived projects.</p>
          )}
          {archived.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <Link
                to="/$orgSlug/projects/$projectKey"
                params={{ orgSlug, projectKey: p.key }}
                className="truncate text-sm text-muted-foreground hover:underline"
              >
                {p.name}
              </Link>
              <span className="text-xs text-muted-foreground">{p.key}</span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={restore.isPending}
                onClick={() => restore.mutate({ key: p.key, archive: false })}
              >
                Restore
              </Button>
            </div>
          ))}
        </section>
      </main>
      {editing && (
        <ProjectSettingsDialog
          orgSlug={orgSlug}
          project={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </>
  );
}
