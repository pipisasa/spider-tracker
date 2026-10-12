import { Board } from "@/components/board";
import { DocumentList, NewDocumentDialog } from "@/components/documents";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { TaskList } from "@/components/task-list";
import { ProjectSettingsDialog } from "@/components/project-settings";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { documentsQuery, membersQuery, projectQuery, tagsQuery, tasksQuery, useArchiveProject } from "@/lib/work";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FileTextIcon, KanbanIcon, ListIcon, PlusIcon, SettingsIcon } from "lucide-react";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const restore = useArchiveProject(orgSlug);
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const archived = project.archivedAt !== null;

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
          ) : archived ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button swallows pointer events, so the span carries the tooltip. */}
                <span className="ml-2" tabIndex={0}>
                  <Button size="sm" disabled>
                    <PlusIcon />
                    New task
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>This project is archived. Restore it to create tasks.</TooltipContent>
            </Tooltip>
          ) : (
            membership.actor.role !== "guest" && (
              <Button size="sm" className="ml-2" onClick={() => openNewTask()}>
                <PlusIcon />
                New task
              </Button>
            )
          )}
          {canManage && (
            <Button variant="ghost" size="icon" aria-label="Project settings" onClick={() => setSettingsOpen(true)}>
              <SettingsIcon />
            </Button>
          )}
        </div>
      </header>
      {archived && (
        <div role="status" className="flex items-center gap-3 border-b bg-muted px-6 py-2 text-sm">
          <span>This project is archived. Its tasks stay readable, but no new tasks can be created.</span>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={restore.isPending}
              onClick={() => restore.mutate({ key: project.key, archive: false })}
            >
              Restore
            </Button>
          )}
        </div>
      )}
      {view === "docs" ? (
        <ProjectDocuments orgSlug={orgSlug} projectKey={project.key} />
      ) : view === "board" ? (
        <Board
          orgSlug={orgSlug}
          statuses={project.statuses}
          tasks={tasks}
          members={members}
          tags={tags}
          onAdd={membership.actor.role !== "guest" ? openNewTask : undefined}
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
      {canManage && (
        <ProjectSettingsDialog orgSlug={orgSlug} project={project} open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
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
