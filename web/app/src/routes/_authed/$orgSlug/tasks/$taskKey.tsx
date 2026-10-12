import { TaskDocuments, TaskMentions } from "@/components/documents";
import { DuplicateDialog } from "@/components/duplicate-dialog";
import { Relations } from "@/components/relations";
import { ReleasePanel, ShippingChip } from "@/components/releases";
import { Subtasks } from "@/components/subtasks";
import { TagPicker } from "@/components/tags";
import { TaskComments } from "@/components/task-comments";
import { ActorAvatar, AssigneePicker, DateInput, PrioritySelect, StatusSelect } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { afterSave, descriptionToSave, remoteChange } from "@/components/editor/description-sync";
import { actorLabel } from "@/lib/assignees";
import { useWorkingNow } from "@/lib/use-presence";
import { actorsQuery, membersQuery, projectQuery, releaseQuery, taskQuery, useDeleteTask, useUpdateTask } from "@/lib/work";
import type { TaskDto } from "@repo/core/contracts";
import { branchNameFor } from "@repo/core/git";
import { allStatuses, kindOf, workflowOf } from "@repo/core/statuses";
import { isOverdue, type UpdateTaskInput } from "@repo/core/schemas";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, CopyIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

type SaveCallbacks = { onSuccess?: () => void; onError?: () => void };

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
  const { data: actors = [] } = useQuery(actorsQuery(orgSlug));
  const { membership } = Route.useRouteContext();
  const working = useWorkingNow(orgSlug, task.key);
  // Assignees show their own indicator; other agents working on the task are named here.
  const visitors = actors.filter((a) => working.includes(a.id) && !task.assigneeIds.includes(a.id));
  const update = useUpdateTask(orgSlug);
  const remove = useDeleteTask(orgSlug);
  const navigate = useNavigate();
  const [markingDuplicate, setMarkingDuplicate] = useState(false);
  const canEdit = membership.actor.role !== "guest";

  const save = (input: UpdateTaskInput, callbacks?: SaveCallbacks) =>
    update.mutate({ taskKey: task.key, input }, callbacks);
  const creator = actors.find((m) => m.id === task.creatorId);
  // Every kind's statuses, for looking up other tasks' (ST-90); the picker offers this task's workflow.
  const statuses = allStatuses(project);
  const overdue = isOverdue(task, statuses.find((s) => s.id === task.statusId)?.category);
  const category = statuses.find((s) => s.id === task.statusId)?.category;
  const isRelease = kindOf(task) === "release";
  const { data: release } = useQuery({ ...releaseQuery(orgSlug, task.key), enabled: isRelease });

  function deleteTask() {
    remove.mutate(task.key, {
      onSuccess: async () => {
        toast.success(`Deleted ${task.key}`);
        await navigate({ to: "/$orgSlug/projects/$projectKey", params: { orgSlug, projectKey: project.key } });
      },
      onError: (err) => toast.error(err.message),
    });
  }

  async function copyBranchName() {
    const branch = branchNameFor(task.key, task.title);
    try {
      await navigator.clipboard.writeText(branch);
      toast.success(`Copied ${branch}`);
    } catch {
      toast.error("Couldn't copy the branch name");
    }
  }

  const fields = (
    <>
        <Field label="Status">
          <StatusSelect statuses={workflowOf(project, kindOf(task))} value={task.statusId} onChange={(statusId) => save({ statusId })} />
        </Field>
        <Field label="Priority">
          <PrioritySelect value={task.priority} onChange={(priority) => save({ priority })} />
        </Field>
        <Field label="Assignees">
          <AssigneePicker
            members={members}
            actors={actors}
            value={task.assigneeIds}
            working={working}
            onChange={(assigneeIds) => save({ assigneeIds })}
          />
        </Field>
        <Field label="Tags">
          <TagPicker orgSlug={orgSlug} value={task.tagIds ?? []} onChange={(tagIds) => save({ tagIds })} />
        </Field>
        <Field label="Start date">
          <DateInput label="Start date" value={task.startDate} max={task.targetDate} onChange={(startDate) => save({ startDate })} />
        </Field>
        <Field label={overdue ? "Target date · overdue" : "Target date"}>
          <DateInput
            label="Target date"
            value={task.targetDate}
            min={task.startDate}
            invalid={overdue}
            onChange={(targetDate) => save({ targetDate })}
          />
        </Field>
        <Field label="Created">
          <span className="flex items-center gap-2 text-sm">
            {creator && <ActorAvatar actor={creator} className="size-5" />}
            {creator ? actorLabel(creator) : "Unknown"} · {dateTimeFormat.format(new Date(task.createdAt))}
          </span>
        </Field>
        {task.completedAt && (
          <Field label="Completed">
            <span className="text-sm">{dateTimeFormat.format(new Date(task.completedAt))}</span>
          </Field>
        )}
        {/* Done means finished; shipping is tracked by releases (ST-93). */}
        {task.shipping && (
          <Field label="Shipping">
            <span className="flex flex-col gap-1 text-sm">
              {task.shipping.release ? (
                <Link to="/$orgSlug/tasks/$taskKey" params={{ orgSlug, taskKey: task.shipping.release.key }} className="w-fit hover:underline">
                  <ShippingChip shipping={task.shipping} />
                </Link>
              ) : (
                <ShippingChip shipping={task.shipping} />
              )}
              {task.shippedAt && <span className="text-xs text-muted-foreground">{dateTimeFormat.format(new Date(task.shippedAt))}</span>}
            </span>
          </Field>
        )}
        {isRelease && task.shippedAt && (
          <Field label="Released">
            <span className="text-sm">{dateTimeFormat.format(new Date(task.shippedAt))}</span>
          </Field>
        )}
        {canEdit && kindOf(task) === "task" && category === "done" && !task.releaseId && !task.shippedAt && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={task.noCode} onChange={(e) => save({ noCode: e.target.checked })} />
            No code to ship
          </label>
        )}
        <Button variant="ghost" className="mt-auto justify-start" onClick={copyBranchName}>
          <GitBranchIcon />
          Copy branch name
        </Button>
        {canEdit && (
          <Button variant="ghost" className="justify-start" onClick={() => setMarkingDuplicate(true)}>
            <CopyIcon />
            Duplicate of…
          </Button>
        )}
        <Button
          variant="ghost"
          className="justify-start text-destructive hover:text-destructive"
          onClick={deleteTask}
          disabled={remove.isPending}
        >
          <Trash2Icon />
          Delete task
        </Button>
    </>
  );

  return (
    <div className="flex flex-1">
      <main className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-8 md:py-6">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
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
        {visitors.length > 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
            Working now: {visitors.map((a) => `@${a.handle}`).join(", ")}
          </p>
        )}
        {/* Keyed by task so local edits reset when navigating between tasks. */}
        <TaskText key={task.id} task={task} onSave={save} canEdit={membership.actor.role !== "guest"}
          afterTitle={<div className="flex flex-col gap-4 rounded-lg border p-3 md:hidden">{fields}</div>}
        />
        {release && <ReleasePanel orgSlug={orgSlug} release={release} canWrite={canEdit} />}
        <Subtasks
          key={`subtasks-${task.id}`}
          orgSlug={orgSlug}
          task={task}
          projectKey={project.key}
          statuses={statuses}
          members={actors}
        />
        <Relations key={`relations-${task.id}`} orgSlug={orgSlug} taskKey={task.key} statuses={statuses} />
        <TaskDocuments orgSlug={orgSlug} taskKey={task.key} canWrite={membership.actor.role !== "guest"} />
        <TaskMentions orgSlug={orgSlug} taskKey={task.key} />
        <TaskComments orgSlug={orgSlug} taskKey={task.key} members={members} statuses={statuses} />
      </main>

      <aside className="hidden w-72 shrink-0 flex-col gap-4 border-l p-4 md:flex">{fields}</aside>
      <DuplicateDialog orgSlug={orgSlug} taskKey={task.key} open={markingDuplicate} onOpenChange={setMarkingDuplicate} />
    </div>
  );
}

const RichEditor = lazy(() => import("@/components/editor/rich-editor"));

function TaskText({
  task,
  onSave,
  canEdit,
  afterTitle,
}: {
  task: TaskDto;
  onSave: (input: UpdateTaskInput, callbacks?: SaveCallbacks) => void;
  canEdit: boolean;
  /** Shown between the title and the description (the side fields on phones). */
  afterTitle?: ReactNode;
}) {
  const [title, setTitle] = useState(task.title);
  // What the editor was mounted with; a new key remounts it with `value`.
  const [loaded, setLoaded] = useState({ value: task.description ?? "", key: 0 });
  // Description sync (see description-sync.ts): the server value the current edit
  // started from, whether the user really edited, and their latest text.
  const baseline = useRef(task.description);
  const dirty = useRef(false);
  const draft = useRef(task.description ?? "");
  // The description being saved, until the save settles (undefined: none in flight).
  const saving = useRef<string | null | undefined>(undefined);
  const conflictToast = useRef<string | number | undefined>(undefined);

  function load(server: string | null) {
    baseline.current = server;
    dirty.current = false;
    draft.current = server ?? "";
    setLoaded((l) => ({ value: server ?? "", key: l.key + 1 }));
  }

  // Baseline and dirty only move once the server accepted the save; the optimistic
  // cache write is not proof, and a rollback must leave the draft alone.
  function saveText(next: string | null) {
    saving.current = next;
    onSave(
      { description: next },
      {
        onSuccess: () => {
          saving.current = undefined;
          const after = afterSave({ saved: next, draft: draft.current });
          baseline.current = after.baseline;
          dirty.current = after.dirty;
          resolveConflict();
        },
        onError: () => {
          saving.current = undefined;
        },
      },
    );
  }

  function resolveConflict() {
    if (conflictToast.current !== undefined) toast.dismiss(conflictToast.current);
    conflictToast.current = undefined;
  }

  useEffect(() => {
    const change = remoteChange({
      server: task.description,
      baseline: baseline.current,
      draft: draft.current,
      dirty: dirty.current,
      saving: saving.current,
    });
    if (change === "none") return;
    if (change === "remount") load(task.description);
    else if (change === "adopt") {
      baseline.current = task.description;
      dirty.current = false;
      resolveConflict();
    } else if (conflictToast.current === undefined) {
      // Keep the user's text, but never save over theirs without asking.
      conflictToast.current = toast.warning("Someone else changed this description", {
        description: "Your edits are kept here but not saved yet.",
        duration: Infinity,
        action: {
          label: "Overwrite theirs",
          onClick: () => {
            conflictToast.current = undefined;
            const next = descriptionToSave({ dirty: true, draft: draft.current, server: null });
            // Once this lands the baseline follows.
            saveText(next ?? null);
          },
        },
        cancel: {
          label: "Use theirs",
          onClick: () => {
            conflictToast.current = undefined;
            load(task.description);
          },
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the server value
  }, [task.description]);

  useEffect(() => resolveConflict, []);

  function saveTitle() {
    if (!canEdit) return;
    const next = title.trim();
    if (!next) return setTitle(task.title);
    if (next !== task.title) onSave({ title: next });
  }

  function saveDescription() {
    // A pending conflict is resolved through its toast, never by a stray blur.
    if (!canEdit || conflictToast.current !== undefined) return;
    const next = descriptionToSave({ dirty: dirty.current, draft: draft.current, server: task.description });
    if (next !== undefined) saveText(next);
  }

  return (
    <>
      <Input
        aria-label="Title"
        className="h-auto border-none px-0 text-2xl font-semibold shadow-none focus-visible:ring-0 md:text-2xl"
        value={title}
        readOnly={!canEdit}
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
      {afterTitle}
      {/* -ml-7 lines the text up with the title; the gutter holds the drag handle. */}
      <Suspense fallback={<div className="min-h-32" />}>
        <RichEditor
          key={loaded.key}
          value={loaded.value}
          editable={canEdit}
          onChange={(markdown) => {
            // Only fires for real document changes, never for focus, blur or mount.
            dirty.current = true;
            draft.current = markdown;
          }}
          onBlur={saveDescription}
          label="Description"
          placeholder="Add a description… type '/' for commands"
          autofocus={false}
          className="min-h-32 md:-ml-7"
        />
      </Suspense>
    </>
  );
}
