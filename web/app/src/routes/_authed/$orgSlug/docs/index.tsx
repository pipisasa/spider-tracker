import { DocumentList, NewDocumentDialog } from "@/components/documents";
import { useAppAction } from "@/lib/app-events";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { filterDocumentsByProject, ORG_FILTER } from "@/lib/document-filter";
import { archivedProjectsQuery, documentsQuery, projectsQuery } from "@/lib/work";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { NetworkIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

// Every document in the organization, project documents included (filter by project); new ones from here are organization-wide.
export const Route = createFileRoute("/_authed/$orgSlug/docs/")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(documentsQuery(params.orgSlug)),
  component: DocumentsPage,
});

function DocumentsPage() {
  const { orgSlug } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { data: documents } = useSuspenseQuery(documentsQuery(orgSlug));
  const { data: projects = [], isSuccess } = useQuery(projectsQuery(orgSlug));
  // Documents can stay in archived projects; those projects stay filterable.
  const hasArchivedDocs =
    isSuccess &&
    documents.some(
      (d) => d.projectKey && !projects.some((p) => p.key === d.projectKey),
    );
  const { data: archived = [] } = useQuery({
    ...archivedProjectsQuery(orgSlug),
    enabled: hasArchivedDocs,
  });
  const archivedWithDocs = archived.filter((p) =>
    documents.some((d) => d.projectKey === p.key),
  );
  const [open, setOpen] = useState(false);
  useAppAction(["new-document"], () => {
    if (membership.actor.role !== "guest") setOpen(true);
  });
  const [filter, setFilter] = useState("all");
  const shown = filterDocumentsByProject(
    documents,
    filter === "all" ? "" : filter,
  );

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-6">
        <h1 className="font-semibold">Documents</h1>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger size="sm" className="ml-auto w-48 max-w-full" aria-label="Filter by project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All documents</SelectItem>
            <SelectItem value={ORG_FILTER}>Organization-wide</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.name} ({p.key})
              </SelectItem>
            ))}
            {archivedWithDocs.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.name} ({p.key}, archived)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" asChild>
          <Link to="/$orgSlug/docs/graph" params={{ orgSlug }}>
            <NetworkIcon />
            Graph
          </Link>
        </Button>
        {membership.actor.role !== "guest" && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <PlusIcon />
            New document
          </Button>
        )}
      </header>
      <main className="flex flex-col gap-3 overflow-y-auto px-4 py-4 md:px-6">
        <DocumentList
          orgSlug={orgSlug}
          documents={shown}
          showScope
          empty="No documents yet. Write specs, plans and reports here, or attach them to projects and tasks."
        />
      </main>
      <NewDocumentDialog
        orgSlug={orgSlug}
        scope={{}}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
