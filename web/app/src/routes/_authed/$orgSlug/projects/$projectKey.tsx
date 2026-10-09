import { Board } from "@/components/board";
import { DocumentList, NewDocumentDialog } from "@/components/documents";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { TaskList } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { documentsQuery, membersQuery, projectQuery, tagsQuery, tasksQuery } from "@/lib/work";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FileTextIcon, KanbanIcon, ListIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

type View = "board" | "list" | "docs";

export const Route = createFileRoute("/_authed/$orgSlug/projects/$projectKey")({
  validateSearch: (search: Record<string, unknown>): { view?: View } =>
    search.view === "list" || search.view === "board" || search.view === "docs" ? { view: search.view } : {},
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(projectQuery(params.orgSlug, params.projectKey)),
      context.queryClient.ensureQueryData(tasksQuery(params.orgSlug, params.projectKey)),
    ]);
  },
  component: ProjectPage,
});

function ProjectPage() {
  const { orgSlug, projectKey } = Route.useParams();
  const { view = "board" } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { data: project } = useSuspenseQuery(projectQuery(orgSlug, projectKey));
  const { data: tasks } = useSuspenseQuery(tasksQuery(orgSlug, projectKey));
  const { data: members = [] } = useQuery(membersQuery(orgSlug));
  const { data: tags = [] } = useQuery(tagsQuery(orgSlug));
  const [newTaskStatus, setNewTaskStatus] = useState<string | undefined>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);

  const openNewTask = (statusId?: string) => {
    setNewTaskStatus(statusId);
    setNewTaskOpen(true);
  };

  return (
    <>
      <header className="flex items-center gap-3 border-b px-6 py-3">
        <h1 className="font-semibold">{project.name}</h1>
        <span className="text-sm text-muted-foreground">{project.key}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant={view === "board" ? "secondary" : "ghost"} size="sm" asChild>
            <Link to="." search={{ view: "board" }}>
              <KanbanIcon />
              Board
            </Link>
          </Button>
          <Button variant={view === "list" ? "secondary" : "ghost"} size="sm" asChild>
            <Link to="." search={{ view: "list" }}>
              <ListIcon />
              List
            </Link>
          </Button>
          <Button variant={view === "docs" ? "secondary" : "ghost"} size="sm" asChild>
            <Link to="." search={{ view: "docs" }}>
              <FileTextIcon />
              Docs
            </Link>
          </Button>
          {view === "docs" ? (
            membership.actor.role !== "guest" && (
              <Button size="sm" className="ml-2" onClick={() => setNewDocumentOpen(true)}>
                <PlusIcon />
                New document
              </Button>
            )
          ) : (
            <Button size="sm" className="ml-2" onClick={() => openNewTask()}>
              <PlusIcon />
              New task
            </Button>
          )}
        </div>
      </header>
      {view === "docs" ? (
        <ProjectDocuments orgSlug={orgSlug} projectKey={project.key} />
      ) : view === "board" ? (
        <Board
          orgSlug={orgSlug}
          statuses={project.statuses}
          tasks={tasks}
          members={members}
          tags={tags}
          onAdd={openNewTask}
        />
      ) : (
        <TaskList orgSlug={orgSlug} statuses={project.statuses} tasks={tasks} members={members} tags={tags} />
      )}
      <NewTaskDialog
        orgSlug={orgSlug}
        project={project}
        members={members}
        defaultStatusId={newTaskStatus}
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
      />
      <NewDocumentDialog
        orgSlug={orgSlug}
        scope={{ project: project.key }}
        open={newDocumentOpen}
        onOpenChange={setNewDocumentOpen}
      />
    </>
  );
}

function ProjectDocuments({ orgSlug, projectKey }: { orgSlug: string; projectKey: string }) {
  const { data: documents = [], isPending } = useQuery(documentsQuery(orgSlug, { project: projectKey }));
  return (
    <main className="flex flex-col gap-3 overflow-y-auto px-6 py-4">
      {!isPending && (
        <DocumentList
          orgSlug={orgSlug}
          documents={documents}
          showScope
          empty="No documents in this project yet. Specs written here are listed for agents working on its tasks."
        />
      )}
    </main>
  );
}
