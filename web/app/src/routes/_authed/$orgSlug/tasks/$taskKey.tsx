import { Subtasks } from "@/components/subtasks";
import { TagPicker } from "@/components/tags";
import { TaskComments } from "@/components/task-comments";
import { ActorAvatar, AssigneePicker, PrioritySelect, StatusSelect } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { membersQuery, projectQuery, taskQuery, useDeleteTask, useUpdateTask } from "@/lib/work";
import type { TaskDto } from "@repo/core/contracts";
import type { UpdateTaskInput } from "@repo/core/schemas";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

const projectKeyOf = (taskKey: string) => taskKey.slice(0, taskKey.lastIndexOf("-")).toUpperCase();
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export const Route = createFileRoute("/_authed/$orgSlug/tasks/$taskKey")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(taskQuery(params.orgSlug, params.taskKey)),
      context.queryClient.ensureQueryData(projectQuery(params.orgSlug, projectKeyOf(params.taskKey))),
    ]);
  },
  component: TaskPage,
});

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function TaskPage() {
  const { orgSlug, taskKey } = Route.useParams();
  const { data: task } = useSuspenseQuery(taskQuery(orgSlug, taskKey));
  const { data: project } = useSuspenseQuery(projectQuery(orgSlug, projectKeyOf(taskKey)));
  const { data: members = [] } = useQuery(membersQuery(orgSlug));
  const update = useUpdateTask(orgSlug);
  const remove = useDeleteTask(orgSlug);
  const navigate = useNavigate();

  const save = (input: UpdateTaskInput) => update.mutate({ taskKey: task.key, input });
  const creator = members.find((m) => m.id === task.creatorId);

  function deleteTask() {
    remove.mutate(task.key, {
      onSuccess: async () => {
        toast.success(`Deleted ${task.key}`);
        await navigate({ to: "/$orgSlug/projects/$projectKey", params: { orgSlug, projectKey: project.key } });
      },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-8 py-6">
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <Link
            to="/$orgSlug/projects/$projectKey"
            params={{ orgSlug, projectKey: project.key }}
            className="hover:text-foreground"
          >
            {project.name}
          </Link>
          <ChevronRightIcon className="size-4" />
          {task.parentKey && (
            <>
              <Link to="/$orgSlug/tasks/$taskKey" params={{ orgSlug, taskKey: task.parentKey }} className="hover:text-foreground">
                {task.parentKey}
              </Link>
              <ChevronRightIcon className="size-4" />
            </>
          )}
          <span>{task.key}</span>
        </nav>
        {/* Keyed by task so local edits reset when navigating between tasks. */}
        <TaskText key={task.id} task={task} onSave={save} />
        <Subtasks
          key={`subtasks-${task.id}`}
          orgSlug={orgSlug}
          task={task}
          projectKey={project.key}
          statuses={project.statuses}
          members={members}
        />
        <TaskComments orgSlug={orgSlug} taskKey={task.key} members={members} statuses={project.statuses} />
      </main>

      <aside className="flex w-72 shrink-0 flex-col gap-4 border-l p-4">
        <Field label="Status">
          <StatusSelect statuses={project.statuses} value={task.statusId} onChange={(statusId) => save({ statusId })} />
        </Field>
        <Field label="Priority">
          <PrioritySelect value={task.priority} onChange={(priority) => save({ priority })} />
        </Field>
        <Field label="Assignees">
          <AssigneePicker
            members={members}
            value={task.assigneeIds}
            onChange={(assigneeIds) => save({ assigneeIds })}
          />
        </Field>
        <Field label="Tags">
          <TagPicker orgSlug={orgSlug} value={task.tagIds ?? []} onChange={(tagIds) => save({ tagIds })} />
        </Field>
        <Field label="Created">
          <span className="flex items-center gap-2 text-sm">
            {creator && <ActorAvatar actor={creator} className="size-5" />}
            {creator?.name ?? "Unknown"} · {dateTimeFormat.format(new Date(task.createdAt))}
          </span>
        </Field>
        {task.completedAt && (
          <Field label="Completed">
            <span className="text-sm">{dateTimeFormat.format(new Date(task.completedAt))}</span>
          </Field>
        )}
        <Button
          variant="ghost"
          className="mt-auto justify-start text-destructive hover:text-destructive"
          onClick={deleteTask}
          disabled={remove.isPending}
        >
          <Trash2Icon />
          Delete task
        </Button>
      </aside>
    </div>
  );
}

function TaskText({ task, onSave }: { task: TaskDto; onSave: (input: UpdateTaskInput) => void }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");

  function saveTitle() {
    const next = title.trim();
    if (!next) return setTitle(task.title);
    if (next !== task.title) onSave({ title: next });
  }

  function saveDescription() {
    const next = description.trim() ? description : null;
    if (next !== task.description) onSave({ description: next });
  }

  return (
    <>
      <Input
        aria-label="Title"
        className="h-auto border-none px-0 text-2xl font-semibold shadow-none focus-visible:ring-0 md:text-2xl"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setTitle(task.title);
            e.currentTarget.blur();
          }
        }}
      />
      <Textarea
        aria-label="Description"
        placeholder="Add a description… (Markdown)"
        className="min-h-48 resize-y border-none px-0 shadow-none focus-visible:ring-0"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={saveDescription}
      />
    </>
  );
}
