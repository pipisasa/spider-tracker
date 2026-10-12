import { ActorAvatar, StatusIcon } from "@/components/task-fields";
import { Input } from "@/components/ui/input";
import { assigneesOf } from "@/lib/assignees";
import { keys, subtasksQuery, useCreateTask } from "@/lib/work";
import type { ActorDto, StatusDto, TaskDto } from "@repo/core/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

/** Sub-tasks of a task, with a one-line form to add one in the same project (ST-9). */
export function Subtasks({
  orgSlug,
  task,
  projectKey,
  statuses,
  members,
}: {
  orgSlug: string;
  task: TaskDto;
  projectKey: string;
  statuses: StatusDto[];
  members: ActorDto[];
}) {
  const { data: subtasks = [] } = useQuery(subtasksQuery(orgSlug, task.key));
  const create = useCreateTask(orgSlug, projectKey);
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const done = subtasks.filter((t) => {
    const category = statuses.find((s) => s.id === t.statusId)?.category;
    return category === "done" || category === "canceled";
  }).length;

  function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      { title, parentId: task.id },
      {
        onSuccess: (child) => {
          setTitle("");
          qc.setQueryData<TaskDto[]>(keys.subtasks(orgSlug, task.key), (old) => [...(old ?? []), child]);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        Sub-tasks
        {subtasks.length > 0 && (
          <span className="text-xs font-normal">
            {done}/{subtasks.length} done
          </span>
        )}
      </h2>
      {subtasks.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {subtasks.map((child) => {
            const status = statuses.find((s) => s.id === child.statusId);
            return (
              <li key={child.id}>
                <Link
                  to="/$orgSlug/tasks/$taskKey"
                  params={{ orgSlug, taskKey: child.key }}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                >
                  {status && <StatusIcon status={status} />}
                  <span className="w-16 shrink-0 text-muted-foreground">{child.key}</span>
                  <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  <span className="flex -space-x-1.5">
                    {assigneesOf(child.assigneeIds, memberMap)
                      .slice(0, 3)
                      .map((m) => (
                        <ActorAvatar key={m.id} actor={m} className="size-5 ring-2 ring-background" />
                      ))}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add}>
        <Input
          aria-label="New sub-task"
          placeholder="Add a sub-task… (Enter)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={create.isPending}
        />
      </form>
    </section>
  );
}
