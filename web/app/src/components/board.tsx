import { ReleaseCardBody, ShippingChip } from "@/components/releases";
import { TagChips } from "@/components/tags";
import { WorkingAvatars } from "@/components/working-avatars";
import { PriorityIcon, StatusIcon } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { assigneesOf } from "@/lib/assignees";
import { useAddToRelease, useUpdateTask } from "@/lib/work";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { boardColumns } from "@repo/core/board";
import type { ActorDto, ReleaseDto, StatusDto, TagDto, TaskDto } from "@repo/core/contracts";
import { Link } from "@tanstack/react-router";
import { generateKeyBetween } from "fractional-indexing";
import { ListChecksIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const columnId = (statusId: string) => `column:${statusId}`;
const releaseDropId = (releaseId: string) => `release:${releaseId}`;

function TaskCard({
  task,
  orgSlug,
  members,
  tags,
  dragging,
}: {
  task: TaskDto;
  orgSlug: string;
  members: Map<string, ActorDto>;
  tags: TagDto[];
  dragging?: boolean;
}) {
  const sub = task.subtasks;
  const assignees = assigneesOf(task.assigneeIds, members);
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs ${dragging ? "shadow-lg ring-2 ring-ring/40" : ""}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <PriorityIcon priority={task.priority} className="size-3.5" />
        <span>{task.key}</span>
        <WorkingAvatars orgSlug={orgSlug} taskKey={task.key} actors={assignees} ringClassName="ring-card" className="ml-auto" />
      </div>
      <Link
        to="/$orgSlug/tasks/$taskKey"
        params={{ orgSlug, taskKey: task.key }}
        className="line-clamp-3 font-medium after:absolute after:inset-0"
        draggable={false}
      >
        {task.title}
      </Link>
      <TagChips tagIds={task.tagIds} tags={tags} />
      {/* Done means finished: where the task's code is (ST-93). */}
      <ShippingChip shipping={task.shipping} />
      {sub && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <ListChecksIcon className="size-3.5" />
          {sub.done}/{sub.total}
        </span>
      )}
    </div>
  );
}

function SortableTask({
  task,
  orgSlug,
  members,
  tags,
}: {
  task: TaskDto;
  orgSlug: string;
  members: Map<string, ActorDto>;
  tags: TagDto[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { statusId: task.statusId },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`relative ${isDragging ? "opacity-40" : ""}`}
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} orgSlug={orgSlug} members={members} tags={tags} />
    </div>
  );
}

function Column({
  status,
  tasks,
  orgSlug,
  members,
  tags,
  onAdd,
}: {
  status: StatusDto;
  tasks: TaskDto[];
  orgSlug: string;
  members: Map<string, ActorDto>;
  tags: TagDto[];
  onAdd?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId(status.id), data: { statusId: status.id } });
  return (
    <section className="flex min-h-0 w-[85vw] max-w-80 shrink-0 snap-center flex-col gap-2 md:w-72 md:snap-align-none">
      <header className="flex shrink-0 items-center gap-2 px-1 text-sm font-medium">
        <StatusIcon status={status} />
        {status.name}
        <span className="text-muted-foreground">{tasks.length}</span>
        {onAdd && (
          <Button variant="ghost" size="icon" className="ml-auto size-9 md:size-6" aria-label={`Add to ${status.name}`} onClick={onAdd}>
            <PlusIcon className="size-4" />
          </Button>
        )}
      </header>
      <div
        ref={setNodeRef}
        className={`flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain rounded-lg p-1 transition-colors ${isOver ? "bg-muted" : "bg-muted/40"}`}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTask key={task.id} task={task} orgSlug={orgSlug} members={members} tags={tags} />
          ))}
        </SortableContext>
      </div>
    </section>
  );
}

/** A release card: a drop target for Done tasks while the release is on its way (ST-93). */
function ReleaseCard({ release, orgSlug, accepts }: { release: ReleaseDto; orgSlug: string; accepts: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: releaseDropId(release.id), data: { releaseKey: release.key }, disabled: !accepts });
  return (
    <div
      ref={setNodeRef}
      className={`relative rounded-lg border bg-card p-3 text-sm shadow-xs transition-colors hover:border-ring ${isOver ? "ring-2 ring-ring/60" : ""}`}
    >
      <Link
        to="/$orgSlug/tasks/$taskKey"
        params={{ orgSlug, taskKey: release.key }}
        className="after:absolute after:inset-0"
        aria-label={`Release ${release.title} (${release.key})`}
        draggable={false}
      />
      <ReleaseCardBody release={release} />
    </div>
  );
}

function ReleaseColumn({
  status,
  releases,
  orgSlug,
  dragging,
  onAdd,
}: {
  status: StatusDto;
  releases: ReleaseDto[];
  orgSlug: string;
  /** A Done task is being dragged: open releases show they take it. */
  dragging: boolean;
  onAdd?: () => void;
}) {
  const open = status.category !== "done" && status.category !== "canceled";
  return (
    <section className="flex min-h-0 w-[85vw] max-w-80 shrink-0 snap-center flex-col gap-2 md:w-72 md:snap-align-none">
      <header className="flex shrink-0 items-center gap-2 px-1 text-sm font-medium">
        <StatusIcon status={status} />
        {status.name}
        <span className="text-muted-foreground">{releases.length}</span>
        {onAdd && (
          <Button variant="ghost" size="icon" className="ml-auto size-9 md:size-6" aria-label={`New release in ${status.name}`} onClick={onAdd}>
            <PlusIcon className="size-4" />
          </Button>
        )}
      </header>
      <div
        className={`flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain rounded-lg border border-dashed p-1 ${dragging && open ? "bg-muted" : "bg-muted/20"}`}
      >
        {releases.map((release) => (
          <ReleaseCard key={release.id} release={release} orgSlug={orgSlug} accepts={open} />
        ))}
        {dragging && open && releases.length > 0 && (
          <p className="px-2 py-1 text-center text-xs text-muted-foreground">Drop a Done task on a release to add it</p>
        )}
      </div>
    </section>
  );
}

export function Board({
  orgSlug,
  statuses,
  tasks,
  members,
  tags,
  onAdd,
  releaseStatuses = [],
  releases = [],
  onAddRelease,
}: {
  orgSlug: string;
  statuses: StatusDto[];
  tasks: TaskDto[];
  members: ActorDto[];
  tags: TagDto[];
  onAdd?: (statusId: string) => void;
  /** The release workflow, when release columns are on (ST-93); empty hides them. */
  releaseStatuses?: StatusDto[];
  releases?: ReleaseDto[];
  onAddRelease?: (statusId: string) => void;
}) {
  const update = useUpdateTask(orgSlug);
  const addToRelease = useAddToRelease(orgSlug);
  const releaseColumns = useMemo(
    () =>
      boardColumns({ statuses: [], workflows: { task: [], release: releaseStatuses } }, [], releases).flatMap((c) =>
        c.type === "releases" ? [c] : [],
      ),
    [releaseStatuses, releases],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // On touch, a short press starts a drag; a quick swipe still scrolls the board.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const byStatus = useMemo(() => {
    const map = new Map<string, TaskDto[]>(statuses.map((s) => [s.id, []]));
    const sorted = [...tasks].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    for (const task of sorted) map.get(task.statusId)?.push(task);
    return map;
  }, [statuses, tasks]);

  const active = activeId ? tasks.find((t) => t.id === activeId) : undefined;

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd({ active: dragged, over }: DragEndEvent) {
    setActiveId(null);
    const task = tasks.find((t) => t.id === dragged.id);
    if (!task || !over) return;

    // Onto a release card: add the Done task to the release (ST-93).
    const releaseKey = over.data.current?.releaseKey as string | undefined;
    if (releaseKey) {
      if (statuses.find((s) => s.id === task.statusId)?.category !== "done") {
        toast.error("Only Done tasks go into a release");
        return;
      }
      addToRelease.mutate(
        { releaseKey, taskKeys: [task.key] },
        { onSuccess: (release) => toast.success(`${task.key} is in release ${release.title}`) },
      );
      return;
    }

    const overTask = tasks.find((t) => t.id === over.id);
    const targetStatusId = overTask?.statusId ?? (over.data.current?.statusId as string | undefined);
    if (!targetStatusId) return;

    // The column as it would look without the dragged task, then the drop index within it.
    const column = (byStatus.get(targetStatusId) ?? []).filter((t) => t.id !== task.id);
    let index = column.length;
    if (overTask && overTask.id !== task.id) {
      const overIndex = column.findIndex((t) => t.id === overTask.id);
      const original = byStatus.get(targetStatusId) ?? [];
      const movingDown =
        task.statusId === targetStatusId &&
        original.findIndex((t) => t.id === task.id) < original.findIndex((t) => t.id === overTask.id);
      index = movingDown ? overIndex + 1 : overIndex;
    } else if (overTask?.id === task.id) {
      return;
    }

    const after = column[index - 1];
    const before = column[index];
    if (task.statusId === targetStatusId && after?.id === previousOf(task, byStatus)?.id) return;

    update.mutate({
      taskKey: task.key,
      input: { position: { statusId: targetStatusId, afterId: after?.id ?? null, beforeId: before?.id ?? null } },
      optimistic: {
        statusId: targetStatusId,
        sortKey: generateKeyBetween(after?.sortKey ?? null, before?.sortKey ?? null),
      },
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:snap-none md:gap-4 md:p-4">
        {statuses.map((status) => (
          <Column
            key={status.id}
            status={status}
            tasks={byStatus.get(status.id) ?? []}
            orgSlug={orgSlug}
            members={memberMap}
            tags={tags}
           
            onAdd={onAdd && (() => onAdd(status.id))}
          />
        ))}
        {releaseColumns.length > 0 && (
          <div className="flex w-5 shrink-0 justify-center pt-1" aria-hidden>
            <span className="text-[11px] tracking-widest text-muted-foreground uppercase [writing-mode:vertical-rl] rotate-180">Releases</span>
          </div>
        )}
        {releaseColumns.map((column) => (
          <ReleaseColumn
            key={column.status.id}
            status={column.status}
            releases={column.releases}
            orgSlug={orgSlug}
            dragging={active !== undefined && statuses.find((s) => s.id === active.statusId)?.category === "done"}
            onAdd={onAddRelease && column.status.category !== "done" && column.status.category !== "canceled" ? () => onAddRelease(column.status.id) : undefined}
          />
        ))}
      </div>
      <DragOverlay>
        {active && <TaskCard task={active} orgSlug={orgSlug} members={memberMap} tags={tags} dragging />}
      </DragOverlay>
    </DndContext>
  );
}

function previousOf(task: TaskDto, byStatus: Map<string, TaskDto[]>) {
  const column = byStatus.get(task.statusId) ?? [];
  return column[column.findIndex((t) => t.id === task.id) - 1];
}
