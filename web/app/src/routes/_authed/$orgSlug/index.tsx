import { NewProjectDialog } from "@/components/new-project-dialog";
import { Button } from "@/components/ui/button";
import { projectsQuery } from "@/lib/work";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

// Organization home: open the first project, or offer to create one.
export const Route = createFileRoute("/_authed/$orgSlug/")({
  beforeLoad: async ({ context, params }) => {
    const projects = await context.queryClient.ensureQueryData(projectsQuery(params.orgSlug));
    const first = projects[0];
    if (first) throw redirect({ to: "/$orgSlug/projects/$projectKey", params: { ...params, projectKey: first.key } });
  },
  component: EmptyOrg,
});

function EmptyOrg() {
  const { orgSlug } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const [open, setOpen] = useState(false);
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold">No projects yet</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Projects hold tasks. Each one gets a short key that prefixes its task numbers.
      </p>
      {canManage ? (
        <Button onClick={() => setOpen(true)}>Create a project</Button>
      ) : (
        <p className="text-sm text-muted-foreground">Ask an admin to create one.</p>
      )}
      <NewProjectDialog orgSlug={orgSlug} open={open} onOpenChange={setOpen} />
    </main>
  );
}
