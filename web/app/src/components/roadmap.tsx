import { ShippingChip } from "@/components/releases";
import { StatusIcon, formatDay } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateMilestone } from "@/lib/work";
import { milestoneProgressLabel } from "@repo/core/board";
import type {
  MilestoneDto,
  MilestoneProgressDto,
  MilestoneRefDto,
  ProjectDetailDto,
  StatusDto,
} from "@repo/core/contracts";
import { datesInOrder } from "@repo/core/schemas";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FlagIcon,
  PackageIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

// Milestones and the project's Roadmap (ST-96): milestones by date with their progress, target
// date, tasks and the releases that moved them forward; the milestone panel of a milestone's page
// and the milestone picker of a task's page.

const DESCRIPTION_TEMPLATE = "**Goal:** \n\n**Done when:** ";

/** One labeled meter: `value` of `max`, as text and a thin bar. */
function Meter({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: string;
}) {
  const percent = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums text-foreground">
          {value}/{max}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} of ${max}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Done of all tasks, and shipped of the Done tasks with code (shown once there are some). */
export function MilestoneProgress({
  progress,
}: {
  progress: MilestoneProgressDto;
}) {
  if (progress.total === 0)
    return <p className="text-sm text-muted-foreground">No tasks yet.</p>;
  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
      title={milestoneProgressLabel(progress)}
    >
      <Meter
        label={`Done${progress.canceled ? ` · ${progress.canceled} canceled not counted` : ""}`}
        value={progress.done}
        max={progress.total}
        tone="bg-primary"
      />
      {progress.withCode > 0 ? (
        <Meter
          label="Shipped (Done with code)"
          value={progress.shipped}
          max={progress.withCode}
          tone="bg-indigo-500"
        />
      ) : (
        <p className="self-end text-xs text-muted-foreground">
          No Done tasks with code to ship yet.
        </p>
      )}
    </div>
  );
}

const statusOf = (
  project: ProjectDetailDto,
  m: Pick<MilestoneDto, "statusId" | "status">,
): Pick<StatusDto, "category" | "color"> =>
  project.workflows.milestone.find((s) => s.id === m.statusId) ?? {
    category: m.status.category,
    color: null,
  };

function Dates({
  milestone,
}: {
  milestone: Pick<MilestoneDto, "startDate" | "targetDate">;
}) {
  if (!milestone.startDate && !milestone.targetDate)
    return <span>No dates</span>;
  return (
    <span>
      {milestone.startDate ? formatDay(milestone.startDate) : "…"} →{" "}
      {milestone.targetDate
        ? `target ${formatDay(milestone.targetDate)}`
        : "no target"}
    </span>
  );
}

/** The releases that shipped (or are shipping) some of the milestone's tasks. */
function ReleaseChips({
  orgSlug,
  milestone,
}: {
  orgSlug: string;
  milestone: MilestoneDto;
}) {
  if (milestone.releases.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <PackageIcon className="size-3.5 text-muted-foreground" aria-hidden />
      {milestone.releases.map((r) => (
        <Link
          key={r.id}
          to="/$orgSlug/tasks/$taskKey"
          params={{ orgSlug, taskKey: r.key }}
          className="rounded-md border px-1.5 hover:bg-muted"
          title={`${r.key} · ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} · ${r.shippedAt ? `shipped ${r.shippedAt.slice(0, 10)}` : r.status.name}`}
        >
          {r.title}
          <span className="text-muted-foreground">
            {" "}
            · {r.shippedAt ? "shipped" : r.status.name.toLowerCase()}
          </span>
        </Link>
      ))}
    </div>
  );
}

/** A milestone's tasks: key, title, status and shipping; inherited sub-tasks are indented. */
export function MilestoneTasks({
  orgSlug,
  milestone,
}: {
  orgSlug: string;
  milestone: MilestoneDto;
}) {
  if (milestone.tasks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No tasks yet. Put a task in this milestone from its page (Milestone
        field).
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border text-sm">
      {milestone.tasks.map((t) => (
        <li
          key={t.id}
          className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 ${t.inherited ? "pl-6" : ""}`}
        >
          <StatusIcon
            status={{ category: t.status.category, color: null }}
            className="size-3.5"
          />
          <Link
            to="/$orgSlug/tasks/$taskKey"
            params={{ orgSlug, taskKey: t.key }}
            className="font-mono text-xs text-muted-foreground hover:underline"
          >
            {t.key}
          </Link>
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          <span className="text-xs text-muted-foreground">{t.status.name}</span>
          <ShippingChip shipping={t.shipping} />
        </li>
      ))}
    </ul>
  );
}

function MilestoneCard({
  orgSlug,
  project,
  milestone,
}: {
  orgSlug: string;
  project: ProjectDetailDto;
  milestone: MilestoneDto;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-expanded={open}
          aria-label={
            open
              ? `Hide the tasks of ${milestone.title}`
              : `Show the tasks of ${milestone.title}`
          }
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            to="/$orgSlug/tasks/$taskKey"
            params={{ orgSlug, taskKey: milestone.key }}
            className="font-semibold hover:underline"
          >
            {milestone.title}
          </Link>
          <span className="text-xs text-muted-foreground">
            {milestone.key} · <Dates milestone={milestone} />
          </span>
        </div>
        <span className="flex items-center gap-1.5 text-sm">
          <StatusIcon
            status={statusOf(project, milestone)}
            className="size-3.5"
          />
          {milestone.status.name}
        </span>
      </header>
      <MilestoneProgress progress={milestone.progress} />
      <ReleaseChips orgSlug={orgSlug} milestone={milestone} />
      {open && <MilestoneTasks orgSlug={orgSlug} milestone={milestone} />}
    </li>
  );
}

export function NewMilestoneDialog({
  orgSlug,
  project,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  project: ProjectDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(DESCRIPTION_TEMPLATE);
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const create = useCreateMilestone(orgSlug, project.key);
  const datesOk = datesInOrder(startDate || null, targetDate || null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !datesOk) return;
    create.mutate(
      {
        title,
        description:
          description.trim() && description !== DESCRIPTION_TEMPLATE
            ? description
            : null,
        startDate: startDate || null,
        targetDate: targetDate || null,
      },
      {
        onSuccess: () => {
          setTitle("");
          setDescription(DESCRIPTION_TEMPLATE);
          setStartDate("");
          setTargetDate("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New milestone in {project.name}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Title</span>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Phase 4: Git and GitHub"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Goal and Done when</span>
            <Textarea
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Start date</span>
              <Input
                type="date"
                value={startDate}
                max={targetDate || undefined}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Target date</span>
              <Input
                type="date"
                value={targetDate}
                min={startDate || undefined}
                aria-invalid={!datesOk || undefined}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </label>
          </div>
          {!datesOk && (
            <p className="text-xs text-destructive">
              The start date must be on or before the target date.
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={create.isPending || !title.trim() || !datesOk}
            >
              {create.isPending ? "Creating…" : "Create milestone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Roadmap view of a project: its milestones by target date (as the server orders them), each
 * with progress, dates and the releases that moved it forward; open one to see its tasks.
 */
export function RoadmapView({
  orgSlug,
  project,
  milestones,
  isPending,
  canWrite,
}: {
  orgSlug: string;
  project: ProjectDetailDto;
  milestones: MilestoneDto[];
  isPending: boolean;
  canWrite: boolean;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const active = milestones.filter(
    (m) => m.status.category === "in_progress",
  ).length;
  return (
    <main className="flex flex-col gap-4 overflow-y-auto px-4 py-4 md:px-6">
      <header className="flex flex-wrap items-center gap-2">
        <FlagIcon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="font-semibold">Roadmap</h2>
        <span className="text-sm text-muted-foreground">
          {milestones.length} milestone{milestones.length === 1 ? "" : "s"}
          {active ? ` · ${active} active` : ""}
        </span>
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setNewOpen(true)}
          >
            <PlusIcon />
            New milestone
          </Button>
        )}
      </header>
      {!isPending && milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No milestones yet. A milestone groups tasks toward a goal; it is ready
          to close once every task is Done and its code has shipped.
        </p>
      ) : (
        <ol className="flex max-w-4xl flex-col gap-3">
          {milestones.map((m) => (
            <MilestoneCard
              key={m.id}
              orgSlug={orgSlug}
              project={project}
              milestone={m}
            />
          ))}
        </ol>
      )}
      <NewMilestoneDialog
        orgSlug={orgSlug}
        project={project}
        open={newOpen}
        onOpenChange={setNewOpen}
      />
    </main>
  );
}

/** A milestone's page section: progress, releases and its tasks. */
export function MilestonePanel({
  orgSlug,
  milestone,
}: {
  orgSlug: string;
  milestone: MilestoneDto;
}) {
  return (
    <section
      aria-labelledby="milestone-panel"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <FlagIcon className="size-4 text-muted-foreground" aria-hidden />
        <h2 id="milestone-panel" className="text-sm font-medium">
          Milestone progress
        </h2>
        {milestone.progress.complete &&
          milestone.status.category !== "done" && (
            <span className="text-xs text-muted-foreground">
              Every task is Done and shipped: check “Done when”, then close it.
            </span>
          )}
      </header>
      <MilestoneProgress progress={milestone.progress} />
      <ReleaseChips orgSlug={orgSlug} milestone={milestone} />
      <h3 className="text-sm font-medium">
        Tasks{" "}
        <span className="text-muted-foreground">{milestone.tasks.length}</span>
      </h3>
      <MilestoneTasks orgSlug={orgSlug} milestone={milestone} />
    </section>
  );
}

const NONE = "none";

/**
 * Picks the task's own milestone among its project's. A sub-task without one shows the milestone
 * it inherits; picking one overrides it, "None" goes back to inheriting.
 */
export function MilestonePicker({
  milestones,
  value,
  current,
  disabled,
  onChange,
}: {
  milestones: Pick<MilestoneDto, "id" | "key" | "title">[];
  /** The task's own milestoneId. */
  value: string | null;
  /** The milestone it belongs to, own or inherited. */
  current: MilestoneRefDto | null;
  disabled?: boolean;
  onChange: (milestoneId: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Select
        value={value ?? NONE}
        disabled={disabled}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger className="w-full" aria-label="Milestone">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            {current?.inherited ? "From its parent" : "None"}
          </SelectItem>
          {milestones.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current?.inherited && (
        <span className="text-xs text-muted-foreground">
          In {current.title} ({current.key}) through its parent
        </span>
      )}
    </div>
  );
}
