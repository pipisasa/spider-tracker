import { StatusIcon } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { projectQuery, useWorkflowMutations } from "@/lib/work";
import type { StatusCategory, StatusDto, TaskKind } from "@repo/core/contracts";
import {
  TASK_KINDS,
  createStatusInput,
  statusCategorySchema,
} from "@repo/core/schemas";
import { workflowOf } from "@repo/core/statuses";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute(
  "/_authed/$orgSlug/settings/workflows/$projectKey",
)({
  beforeLoad: ({ context, params }) => {
    const role = context.membership.actor.role;
    if (role !== "owner" && role !== "admin")
      throw redirect({ to: "/$orgSlug", params });
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      projectQuery(params.orgSlug, params.projectKey),
    ),
  component: WorkflowsPage,
});

const KIND_LABELS: Record<TaskKind, string> = {
  task: "Tasks",
  release: "Releases",
  milestone: "Milestones",
};

const CATEGORY_LABELS: Record<StatusCategory, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

/** A project's workflows (ST-90): the statuses of each task kind, edited by owners and admins. */
function WorkflowsPage() {
  const { orgSlug, projectKey } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(orgSlug, projectKey));
  const [kind, setKind] = useState<TaskKind>("task");
  const [deleting, setDeleting] = useState<StatusDto | null>(null);
  const mutations = useWorkflowMutations(orgSlug, project.key);
  const statuses = workflowOf(project, kind);

  return (
    <>
      <header className="border-b px-4 py-3 md:px-6">
        <h1 className="font-semibold">
          <Link
            to="/$orgSlug/settings/projects"
            params={{ orgSlug }}
            className="text-muted-foreground hover:underline"
          >
            Projects
          </Link>{" "}
          / {project.name} workflows
        </h1>
      </header>
      <main className="flex max-w-2xl flex-col gap-4 px-4 py-4 md:px-6">
        <p className="text-sm text-muted-foreground">
          Each kind of task has its own statuses. Categories can&apos;t change;
          every workflow keeps at least one open status and one done status.
        </p>
        <div className="flex gap-1" role="tablist">
          {TASK_KINDS.map((k) => (
            <Button
              key={k}
              role="tab"
              aria-selected={k === kind}
              variant={k === kind ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setKind(k)}
            >
              {KIND_LABELS[k]}
            </Button>
          ))}
        </div>
        <ol
          className="flex flex-col gap-2"
          aria-label={`${KIND_LABELS[kind]} workflow`}
        >
          {statuses.map((status, index) => (
            <StatusRow
              // Re-seed the inputs when the server's values change.
              key={`${status.id}-${status.name}-${status.color ?? ""}`}
              status={status}
              first={index === 0}
              last={index === statuses.length - 1}
              busy={mutations.update.isPending}
              onUpdate={(input) =>
                mutations.update.mutate({ id: status.id, ...input })
              }
              onDelete={() => setDeleting(status)}
            />
          ))}
        </ol>
        <AddStatusForm
          key={kind}
          kind={kind}
          busy={mutations.create.isPending}
          onAdd={(input, reset) =>
            mutations.create.mutate(input, { onSuccess: reset })
          }
        />
      </main>
      {deleting && (
        <DeleteStatusDialog
          status={deleting}
          others={statuses.filter((s) => s.id !== deleting.id)}
          busy={mutations.remove.isPending}
          onCancel={() => setDeleting(null)}
          onDelete={(moveTo) =>
            mutations.remove.mutate(
              { id: deleting.id, moveTo },
              { onSuccess: () => setDeleting(null) },
            )
          }
        />
      )}
    </>
  );
}

function StatusRow({
  status,
  first,
  last,
  busy,
  onUpdate,
  onDelete,
}: {
  status: StatusDto;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUpdate: (input: {
    name?: string;
    color?: string | null;
    position?: number;
  }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(status.name);
  const rename = () => {
    const next = name.trim();
    if (next && next !== status.name) onUpdate({ name: next });
    else setName(status.name);
  };

  return (
    <li className="flex items-center gap-2 rounded-md border px-3 py-2">
      <StatusIcon status={status} />
      <Input
        aria-label="Status name"
        className="h-8 flex-1"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(status.name);
        }}
      />
      <span className="hidden w-24 text-xs text-muted-foreground sm:block">
        {CATEGORY_LABELS[status.category]}
      </span>
      <input
        type="color"
        aria-label="Status colour"
        className="h-8 w-8 cursor-pointer rounded border bg-transparent"
        defaultValue={status.color ?? "#a1a1aa"}
        onBlur={(e) =>
          e.target.value !== status.color && onUpdate({ color: e.target.value })
        }
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Move up"
        disabled={first || busy}
        onClick={() => onUpdate({ position: status.position - 1 })}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Move down"
        disabled={last || busy}
        onClick={() => onUpdate({ position: status.position + 1 })}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete status"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function AddStatusForm({
  kind,
  busy,
  onAdd,
}: {
  kind: TaskKind;
  busy: boolean;
  onAdd: (
    input: { kind: TaskKind; name: string; category: StatusCategory },
    reset: () => void,
  ) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<StatusCategory>("todo");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createStatusInput.safeParse({ kind, name, category });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    onAdd(
      { kind, name: parsed.data.name, category: parsed.data.category },
      () => setName(""),
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-md border border-dashed p-3"
    >
      <Label htmlFor="new-status-name">Add a status</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="new-status-name"
          className="h-9 min-w-40 flex-1"
          placeholder="Name"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          value={category}
          onValueChange={(v) => setCategory(statusCategorySchema.parse(v))}
        >
          <SelectTrigger className="w-36" aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusCategorySchema.options.map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={busy}>
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

function DeleteStatusDialog({
  status,
  others,
  busy,
  onCancel,
  onDelete,
}: {
  status: StatusDto;
  others: StatusDto[];
  busy: boolean;
  onCancel: () => void;
  onDelete: (moveTo: string) => void;
}) {
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {status.name}?</DialogTitle>
          <DialogDescription>
            Its tasks move to another status of this workflow first.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="move-to">Move its tasks to</Label>
          <Select value={moveTo} onValueChange={setMoveTo}>
            <SelectTrigger id="move-to" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {others.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!moveTo || busy}
            onClick={() => onDelete(moveTo)}
          >
            Delete status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
