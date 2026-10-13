import { TagPicker } from "@/components/tags";
import {
  AssigneePicker,
  PrioritySelect,
  StatusSelect,
} from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCreateTask } from "@/lib/work";
import type {
  ActorDto,
  Priority,
  ProjectDetailDto,
} from "@repo/core/contracts";
import { DATES_OUT_OF_ORDER, datesInOrder } from "@repo/core/schemas";
import {
  lazy,
  Suspense,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";

const RichEditor = lazy(() => import("@/components/editor/rich-editor"));

export function NewTaskDialog({
  orgSlug,
  project,
  members,
  defaultStatusId,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  project: ProjectDetailDto;
  members: ActorDto[];
  defaultStatusId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fallbackStatus =
    project.statuses.find((s) => s.category === "todo") ?? project.statuses[0];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState(
    defaultStatusId ?? fallbackStatus?.id ?? "",
  );
  const [priority, setPriority] = useState<Priority>(0);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  // "YYYY-MM-DD" from the date inputs, "" when unset (ST-91).
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const datesOk = datesInOrder(startDate || null, targetDate || null);
  const create = useCreateTask(orgSlug, project.key);

  // Re-seed the status when the dialog opens from a different column.
  const [seededFor, setSeededFor] = useState(defaultStatusId);
  if (open && seededFor !== defaultStatusId) {
    setSeededFor(defaultStatusId);
    setStatusId(defaultStatusId ?? fallbackStatus?.id ?? "");
  }

  function reset() {
    setTitle("");
    setDescription("");
    setPriority(0);
    setAssigneeIds([]);
    setTagIds([]);
    setStartDate("");
    setTargetDate("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    if (!datesOk) {
      toast.error(DATES_OUT_OF_ORDER);
      return;
    }
    create.mutate(
      {
        title,
        description: description || undefined,
        statusId,
        priority,
        assigneeIds,
        tagIds,
        startDate: startDate || undefined,
        targetDate: targetDate || undefined,
      },
      {
        onSuccess: (task) => {
          toast.success(`Created ${task.key}`);
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  // Cmd/Ctrl+Enter creates the task from anywhere, including inside the editor
  // (captured before ProseMirror sees it).
  function submitShortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          // Esc inside the / menu closes the menu only, not the dialog.
          if (document.querySelector("[data-slash-menu]"))
            event.preventDefault();
        }}
      >
        <form
          onSubmit={submit}
          onKeyDownCapture={submitShortcut}
          className="flex max-h-[85vh] flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>New task in {project.name}</DialogTitle>
          </DialogHeader>
          {/* -ml-7 pl-7: keep the editor gutter (drag handle, +) inside the scroll box */}
          <div className="-ml-7 flex min-h-0 flex-col gap-4 overflow-y-auto pl-7">
            <Input
              autoFocus
              placeholder="Task title"
              aria-label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Suspense fallback={<div className="min-h-32" />}>
              <RichEditor
                value={description}
                onChange={setDescription}
                label="Description"
                placeholder="Add a description… type '/' for commands"
                autofocus={false}
                className="-ml-7 min-h-32 pb-2"
              />
            </Suspense>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <StatusSelect
                statuses={project.statuses}
                value={statusId}
                onChange={setStatusId}
              />
              <PrioritySelect value={priority} onChange={setPriority} />
              <AssigneePicker
                members={members}
                value={assigneeIds}
                onChange={setAssigneeIds}
              />
            </div>
            <TagPicker orgSlug={orgSlug} value={tagIds} onChange={setTagIds} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Start date
                <Input
                  type="date"
                  value={startDate}
                  max={targetDate || undefined}
                  aria-invalid={!datesOk || undefined}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Target date
                <Input
                  type="date"
                  value={targetDate}
                  min={startDate || undefined}
                  aria-invalid={!datesOk || undefined}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={create.isPending || !title.trim() || !datesOk}
            >
              {create.isPending ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
