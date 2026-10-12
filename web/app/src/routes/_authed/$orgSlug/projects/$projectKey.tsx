import { Board } from "@/components/board";
import { DocumentList, NewDocumentDialog } from "@/components/documents";
import { NewTaskDialog } from "@/components/new-task-dialog";
import { TaskList } from "@/components/task-list";
import { ProjectSettingsDialog } from "@/components/project-settings";
import { SavedViewsMenu } from "@/components/saved-views";
import { TaskFilterBar } from "@/components/task-filter-bar";
import { Button } from "@/components/ui/button";
import { useAppAction } from "@/lib/app-events";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  actorsQuery,
  agentsQuery,
  documentsQuery,
  membersQuery,
  projectQuery,
  tagsQuery,
  tasksQuery,
  useArchiveProject,
} from "@/lib/work";
import {
  applyFilters,
  filtersToSearch,
  isEmptyFilters,
  mineActorIds,
  normalizeFilters,
  parseFilters,
  type TaskFilters,
} from "@/lib/task-filters";
import type { SavedViewDto } from "@repo/core/contracts";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileTextIcon, KanbanIcon, ListIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";

type View = "board" | "list" | "docs";

/** `view` plus the task filters (status, assignee, priority, tag, q), all in the URL so links can be shared. */
type ProjectSearch = TaskFilters & { view?: View };

export const Route = createFileRoute("/_authed/$orgSlug/projects/$projectKey")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    ...(search.view === "list" || search.view === "board" || search.view === "docs" ? { view: search.view } : {}),
    ...parseFilters(search),
  }),
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
  const { view = "board", ...filters } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { membership } = Route.useRouteContext();
  const { data: project } = useSuspenseQuery(projectQuery(orgSlug, projectKey));
  const { data: tasks } = useSuspenseQuery(tasksQuery(orgSlug, projectKey));
  const { data: members = [] } = useQuery(membersQuery(orgSlug));
  // Deactivated assignees too, so cards and rows still show them.
  const { data: actors = [] } = useQuery(actorsQuery(orgSlug));
  const { data: tags = [] } = useQuery(tagsQuery(orgSlug));
  // Only for "Me and my agents" (assignee=mine): which agents are the viewer's.
  const mineSelected = filters.assignee?.includes("mine") ?? false;
  const { data: agents } = useQuery({ ...agentsQuery(orgSlug), enabled: mineSelected });
  const [newTaskStatus, setNewTaskStatus] = useState<string | undefined>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const restore = useArchiveProject(orgSlug);
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const archived = project.archivedAt !== null;

  const meId = membership.actor.id;
  const mineIds = useMemo(() => mineActorIds(meId, agents ?? []), [meId, agents]);
  const visibleTasks = useMemo(() => applyFilters(tasks, filters, meId, mineIds), [tasks, filters, meId, mineIds]);
  const filtered = !isEmptyFilters(filters);

  const setFilters = (next: TaskFilters) =>
    void navigate({
      search: (prev) => ({ view: prev.view, ...filtersToSearch(next) }),
      replace: true,
    });

  const applyView = (saved: SavedViewDto) =>
    void navigate({ search: { view: saved.view, ...filtersToSearch(normalizeFilters(saved.filters)) } });

  const openNewTask = (statusId?: string) => {
    setNewTaskStatus(statusId);
    setNewTaskOpen(true);
  };

  // Palette and keyboard shortcuts (ST-16): `c` and "New document" arrive here.
  useAppAction(["new-task", "new-document"], (action) => {
    if (membership.actor.role === "guest") return void toast.error("Guests can't create content.");
    if (archived) return void toast.error("This project is archived. Restore it first.");
    if (action === "new-task") openNewTask();
    else setNewDocumentOpen(true);
  });

  return (
    // The board fills the viewport below the mobile top bar (2.5rem button + 1px border + safe area) so only its columns scroll;
    // list and docs keep normal page scrolling.
    <div
      className={
        view === "board"
          ? "flex h-[calc(100svh-2.5rem-1px-env(safe-area-inset-top))] min-h-0 flex-col overflow-hidden md:h-svh"
          : "flex flex-1 flex-col"
      }
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 md:px-6">
        <h1 className="min-w-0 truncate font-semibold">{project.name}</h1>
        <span className="text-sm text-muted-foreground">{project.key}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button variant={view === "board" ? "secondary" : "ghost"} size="sm" className="max-md:h-10" asChild>
            <Link to="." search={(prev) => ({ ...prev, view: "board" })}>
              <KanbanIcon />
              <span className="max-sm:sr-only">Board</span>
            </Link>
          </Button>
          <Button variant={view === "list" ? "secondary" : "ghost"} size="sm" className="max-md:h-10" asChild>
            <Link to="." search={(prev) => ({ ...prev, view: "list" })}>
              <ListIcon />
              <span className="max-sm:sr-only">List</span>
            </Link>
          </Button>
          <Button variant={view === "docs" ? "secondary" : "ghost"} size="sm" className="max-md:h-10" asChild>
            <Link to="." search={{ view: "docs" }}>
              <FileTextIcon />
              <span className="max-sm:sr-only">Docs</span>
            </Link>
          </Button>
          {view !== "docs" && (
            <SavedViewsMenu
              orgSlug={orgSlug}
              projectKey={project.key}
              filters={filters}
              layout={view}
              actorId={meId}
              role={membership.actor.role}
              onApply={applyView}
            />
          )}
          {view === "docs" ? (
            membership.actor.role !== "guest" &&
            !archived && (
              <Button size="sm" className="ml-2 max-md:h-10" onClick={() => setNewDocumentOpen(true)}>
                <PlusIcon />
                <span className="max-sm:sr-only">New document</span>
              </Button>
            )
          ) : membership.actor.role === "guest" ? null : archived ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button swallows pointer events, so the span carries the tooltip. */}
                <span className="ml-2" tabIndex={0}>
                  <Button size="sm" disabled className="max-md:h-10">
                    <PlusIcon />
                    <span className="max-sm:sr-only">New task</span>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>This project is archived. Restore it to create tasks.</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" className="ml-2 max-md:h-10" onClick={() => openNewTask()}>
                  <PlusIcon />
                  <span className="max-sm:sr-only">New task</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>New task (c)</TooltipContent>
            </Tooltip>
          )}
          {canManage && (
            <Button variant="ghost" size="icon" className="max-md:size-10" aria-label="Project settings" onClick={() => setSettingsOpen(true)}>
              <SettingsIcon />
            </Button>
          )}
        </div>
      </header>
      {archived && (
        <div role="status" className="flex items-center gap-3 border-b bg-muted px-4 py-2 text-sm md:px-6">
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
      {view !== "docs" && (
        <TaskFilterBar
          filters={filters}
          onChange={setFilters}
          statuses={project.statuses}
          members={members}
          actors={actors}
          tags={tags}
          meId={meId}
        />
      )}
      {view !== "docs" && filtered && (
        <p role="status" className="border-b px-4 py-1.5 md:px-6 text-xs text-muted-foreground">
          Showing {visibleTasks.length} of {tasks.length} tasks
        </p>
      )}
      {view === "docs" ? (
        <ProjectDocuments orgSlug={orgSlug} projectKey={project.key} />
      ) : view === "board" ? (
        <Board
          orgSlug={orgSlug}
          statuses={project.statuses}
          tasks={visibleTasks}
          members={actors}
          tags={tags}
          onAdd={!archived && membership.actor.role !== "guest" ? openNewTask : undefined}
        />
      ) : (
        <TaskList orgSlug={orgSlug} statuses={project.statuses} tasks={visibleTasks} members={actors} tags={tags} />
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
    </div>
  );
}

function ProjectDocuments({ orgSlug, projectKey }: { orgSlug: string; projectKey: string }) {
  const { data: documents = [], isPending } = useQuery(documentsQuery(orgSlug, { project: projectKey }));
  return (
    <main className="flex flex-col gap-3 overflow-y-auto px-4 py-4 md:px-6">
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
