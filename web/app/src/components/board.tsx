import { TagChips } from "@/components/tags";
import { ActorAvatar, PriorityIcon, StatusIcon } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { useUpdateTask } from "@/lib/work";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ActorDto, StatusDto, TagDto, TaskDto } from "@repo/core/contracts";
import { Link } from "@tanstack/react-router";
import { generateKeyBetween } from "fractional-indexing";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

const columnId = (statusId: string) => `column:${statusId}`;

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
  const assignees = task.assigneeIds.map((id) => members.get(id)).filter((m): m is ActorDto => !!m);
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-xs ${dragging ? "shadow-lg ring-2 ring-ring/40" : ""}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <PriorityIcon priority={task.priority} className="size-3.5" />
        <span>{task.key}</span>
        <span className="ml-auto flex -space-x-1.5">
          {assignees.slice(0, 3).map((m) => (
            <ActorAvatar key={m.id} actor={m} className="size-5 ring-2 ring-card" />
          ))}
        </span>
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
  onAdd: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId(status.id), data: { statusId: status.id } });
  return (
    <section className="flex w-72 shrink-0 flex-col gap-2">
      <header className="flex items-center gap-2 px-1 text-sm font-medium">
        <StatusIcon status={status} />
        {status.name}
        <span className="text-muted-foreground">{tasks.length}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-6" aria-label={`Add to ${status.name}`} onClick={onAdd}>
          <PlusIcon className="size-4" />
        </Button>
      </header>
      <div
        ref={setNodeRef}
        className={`flex min-h-24 flex-1 flex-col gap-2 rounded-lg p-1 transition-colors ${isOver ? "bg-muted" : "bg-muted/40"}`}
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

export function Board({
  orgSlug,
  statuses,
  tasks,
  members,
  tags,
  onAdd,
}: {
  orgSlug: string;
  statuses: StatusDto[];
  tasks: TaskDto[];
  members: ActorDto[];
  tags: TagDto[];
  onAdd: (statusId: string) => void;
}) {
  const update = useUpdateTask(orgSlug);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
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
      <div className="flex flex-1 gap-4 overflow-x-auto p-4">
        {statuses.map((status) => (
          <Column
            key={status.id}
            status={status}
            tasks={byStatus.get(status.id) ?? []}
            orgSlug={orgSlug}
            members={memberMap}
            tags={tags}
            onAdd={() => onAdd(status.id)}
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
