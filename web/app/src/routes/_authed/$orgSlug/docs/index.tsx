import { DocumentList, NewDocumentDialog } from "@/components/documents";
import { Button } from "@/components/ui/button";
import { documentsQuery } from "@/lib/work";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

// Every document in the organization; new ones from here are organization-wide.
export const Route = createFileRoute("/_authed/$orgSlug/docs/")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(documentsQuery(params.orgSlug)),
  component: DocumentsPage,
});

function DocumentsPage() {
  const { orgSlug } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { data: documents } = useSuspenseQuery(documentsQuery(orgSlug));
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="flex items-center gap-3 border-b px-6 py-3">
        <h1 className="font-semibold">Documents</h1>
        {membership.actor.role !== "guest" && (
          <Button size="sm" className="ml-auto" onClick={() => setOpen(true)}>
            <PlusIcon />
            New document
          </Button>
        )}
      </header>
      <main className="flex flex-col gap-3 overflow-y-auto px-6 py-4">
        <DocumentList
          orgSlug={orgSlug}
          documents={documents}
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
