import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AvatarStack } from "@/components/avatar-stack";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { actorLabel, assigneeOptions, toggleAssignee } from "@/lib/assignees";
import { actorAvatarSrc } from "@/lib/generated-avatar";
import { cn } from "@/lib/utils";
import type {
  ActorDto,
  Priority,
  StatusCategory,
  StatusDto,
  TaskDto,
} from "@repo/core/contracts";
import { isOverdue } from "@repo/core/schemas";
import { useEffect, useState } from "react";
import {
  BotIcon,
  CalendarIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  EqualIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
  SirenIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react";

// Shared controls for task fields: status, priority, assignees, dates.

const categoryIcons: Record<StatusCategory, LucideIcon> = {
  backlog: CircleDashedIcon,
  todo: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotIcon,
  done: CircleCheckIcon,
  canceled: CircleXIcon,
};

export function StatusIcon({
  status,
  className,
}: {
  status: Pick<StatusDto, "category" | "color">;
  className?: string;
}) {
  const Icon = categoryIcons[status.category];
  return (
    <Icon
      className={className ?? "size-4"}
      style={{ color: status.color ?? undefined }}
      aria-hidden
    />
  );
}

export const PRIORITIES: {
  value: Priority;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: 0, label: "No priority", icon: EqualIcon },
  { value: 1, label: "Urgent", icon: SirenIcon },
  { value: 2, label: "High", icon: SignalHighIcon },
  { value: 3, label: "Medium", icon: SignalMediumIcon },
  { value: 4, label: "Low", icon: SignalLowIcon },
];

export function PriorityIcon({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}) {
  const entry = PRIORITIES.find((p) => p.value === priority) ?? PRIORITIES[0];
  if (!entry) return null;
  const Icon = entry.icon;
  return (
    <Icon
      className={className ?? "size-4"}
      style={{ color: priority === 1 ? "var(--destructive)" : undefined }}
      aria-label={entry.label}
    />
  );
}

/** `title={false}` drops the native tooltip (an enclosing AvatarStack provides its own). */
export function ActorAvatar({
  actor,
  className,
  title,
}: {
  actor: ActorDto;
  className?: string;
  title?: string | false;
}) {
  const initials = actor.name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <Avatar
      className={cn(
        className ?? "size-6",
        actor.deactivated && "opacity-50 grayscale",
      )}
      title={title === false ? undefined : (title ?? actorLabel(actor))}
    >
      <AvatarImage src={actorAvatarSrc(actor)} alt="" />
      <AvatarFallback className="text-[10px]">
        {actor.type === "human" ? (
          initials || "?"
        ) : (
          <BotIcon className="size-3" />
        )}
      </AvatarFallback>
    </Avatar>
  );
}

export function StatusSelect({
  statuses,
  value,
  onChange,
}: {
  statuses: StatusDto[];
  value: string;
  onChange: (statusId: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label="Status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {statuses.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <StatusIcon status={s} />
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PrioritySelect({
  value,
  onChange,
}: {
  value: Priority;
  onChange: (priority: Priority) => void;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => onChange(Number(v) as Priority)}
    >
      <SelectTrigger className="w-full" aria-label="Priority">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((p) => (
          <SelectItem key={p.value} value={String(p.value)}>
            <PriorityIcon priority={p.value} />
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Task dates are plain "YYYY-MM-DD" (ST-91): read as UTC midnight so no time zone shifts the day.
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Oct 31", or "Oct 31, 2027" outside the current year. */
export function formatDay(date: string, now: Date = new Date()): string {
  const day = new Date(`${date}T00:00:00Z`);
  return (
    day.getUTCFullYear() === now.getUTCFullYear() ? dayFormat : dayYearFormat
  ).format(day);
}

/** A task's target date for list rows and cards; red when overdue. Nothing when there is none. */
export function TargetDate({
  task,
  category,
  className,
}: {
  task: Pick<TaskDto, "targetDate">;
  category: StatusCategory | undefined;
  className?: string;
}) {
  if (!task.targetDate) return null;
  const overdue = isOverdue(task, category);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs",
        overdue ? "text-destructive" : "text-muted-foreground",
        className,
      )}
      title={`${overdue ? "Overdue · target" : "Target"} ${task.targetDate}`}
    >
      <CalendarIcon className="size-3.5" aria-hidden />
      {formatDay(task.targetDate)}
      {overdue && <span className="sr-only">(overdue)</span>}
    </span>
  );
}

/**
 * A date field that saves on blur or Enter: `onChange` gets "YYYY-MM-DD", or null when cleared.
 * A half-typed date is dropped, not saved as a clear.
 */
export function DateInput({
  label,
  value,
  min,
  max,
  invalid,
  onChange,
}: {
  label: string;
  value: string | null;
  min?: string | null;
  max?: string | null;
  invalid?: boolean;
  onChange: (date: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <Input
      type="date"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={cn("w-full", invalid && "text-destructive")}
      value={draft}
      min={min ?? undefined}
      max={max ?? undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        if (e.currentTarget.validity.badInput) return setDraft(value ?? "");
        const next = draft || null;
        if (next !== value) onChange(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value ?? "");
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Assigns active members; deactivated assignees (from `actors`) are shown and can only be removed. */
export function AssigneePicker({
  members,
  actors = [],
  value,
  onChange,
  working = [],
}: {
  members: ActorDto[];
  actors?: ActorDto[];
  value: string[];
  onChange: (actorIds: string[]) => void;
  /** Ids of agents working on the task right now (ST-67). */
  working?: string[];
}) {
  const { selected, options } = assigneeOptions(members, actors, value);
  const toggle = (actor: ActorDto) => onChange(toggleAssignee(value, actor));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-start gap-2 font-normal"
          aria-label="Assignees"
        >
          {selected.length === 0 ? (
            <>
              <UserPlusIcon className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">Unassigned</span>
            </>
          ) : (
            <>
              <AvatarStack
                actors={selected}
                interactive={false}
                isWorking={(a) => working.includes(a.id)}
                highlight={(a) =>
                  working.includes(a.id) ? "ring-emerald-500" : undefined
                }
              />
              <span className="truncate">
                {selected.map((m, i) => (
                  <span
                    key={m.id}
                    className={
                      m.deactivated ? "text-muted-foreground" : undefined
                    }
                    title={actorLabel(m)}
                  >
                    {i > 0 && ", "}
                    {m.name}
                  </span>
                ))}
              </span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Assign to…" />
          <CommandList>
            <CommandEmpty>No members found.</CommandEmpty>
            <CommandGroup>
              {options.map((m) => (
                <CommandItem
                  key={m.id}
                  value={`${m.name} ${m.handle}`}
                  onSelect={() => toggle(m)}
                  className={
                    m.deactivated ? "text-muted-foreground" : undefined
                  }
                  title={
                    m.deactivated
                      ? `${actorLabel(m)}: can be removed, not assigned again`
                      : undefined
                  }
                >
                  <ActorAvatar actor={m} className="size-5" />
                  <span className="truncate">{actorLabel(m)}</span>
                  {value.includes(m.id) && (
                    <CheckIcon className="ml-auto size-4" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
