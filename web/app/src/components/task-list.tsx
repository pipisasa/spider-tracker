import { TagChips } from "@/components/tags";
import { AvatarStack } from "@/components/avatar-stack";
import { PriorityIcon, StatusIcon } from "@/components/task-fields";
import { assigneesOf } from "@/lib/assignees";
import type { ActorDto, StatusDto, TagDto, TaskDto } from "@repo/core/contracts";
import { ListChecksIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function TaskList({
  orgSlug,
  statuses,
  tasks,
  members,
  tags,
}: {
  orgSlug: string;
  statuses: StatusDto[];
  tasks: TaskDto[];
  members: ActorDto[];
  tags: TagDto[];
}) {
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const groups = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return statuses
      .map((status) => ({ status, tasks: sorted.filter((t) => t.statusId === status.id) }))
      .filter((g) => g.tasks.length > 0);
  }, [statuses, tasks]);

  if (groups.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">No tasks yet.</p>;
  }

  return (
    <div className="flex flex-col pb-8">
      {groups.map(({ status, tasks: groupTasks }) => (
        <section key={status.id}>
          <header className="flex items-center gap-2 border-b bg-muted/40 px-6 py-2 text-sm font-medium">
            <StatusIcon status={status} />
            {status.name}
            <span className="text-muted-foreground">{groupTasks.length}</span>
          </header>
          <ul>
            {groupTasks.map((task) => (
              <li key={task.id} className="border-b last:border-b-0">
                <Link
                  to="/$orgSlug/tasks/$taskKey"
                  params={{ orgSlug, taskKey: task.key }}
                  className="flex items-center gap-3 px-6 py-2 text-sm hover:bg-muted/50"
                >
                  <PriorityIcon priority={task.priority} className="size-4 text-muted-foreground" />
                  <span className="w-16 shrink-0 text-muted-foreground">{task.key}</span>
                  <StatusIcon status={status} />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  {task.subtasks && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <ListChecksIcon className="size-3.5" aria-hidden />
                      {task.subtasks.done}/{task.subtasks.total}
                    </span>
                  )}
                  <TagChips tagIds={task.tagIds} tags={tags} className="shrink-0" />
                  <AvatarStack actors={assigneesOf(task.assigneeIds, memberMap)} />
                  <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
                    {dateFormat.format(new Date(task.createdAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
