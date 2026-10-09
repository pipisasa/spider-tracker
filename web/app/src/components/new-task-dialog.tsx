import { AssigneePicker, PrioritySelect, StatusSelect } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateTask } from "@/lib/work";
import type { ActorDto, Priority, ProjectDetailDto } from "@repo/core/contracts";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

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
  const fallbackStatus = project.statuses.find((s) => s.category === "todo") ?? project.statuses[0];
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState(defaultStatusId ?? fallbackStatus?.id ?? "");
  const [priority, setPriority] = useState<Priority>(0);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
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
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      { title, description: description || undefined, statusId, priority, assigneeIds },
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New task in {project.name}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Task title"
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            placeholder="Add a description… (Markdown)"
            aria-label="Description"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="grid grid-cols-3 gap-2">
            <StatusSelect statuses={project.statuses} value={statusId} onChange={setStatusId} />
            <PrioritySelect value={priority} onChange={setPriority} />
            <AssigneePicker members={members} value={assigneeIds} onChange={setAssigneeIds} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !title.trim()}>
              {create.isPending ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
