import { PRIORITIES, PriorityIcon, StatusIcon } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { actorLabel } from "@/lib/assignees";
import { isEmptyFilters, toggleValue, type TaskFilters } from "@/lib/task-filters";
import type { ActorDto, Priority, StatusDto, TagDto } from "@repo/core/contracts";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

// Filter bar of the project page (ST-15): a text box, one multi-select per field, and chips
// for what's active. State lives in the URL (see lib/task-filters).

const FALLBACK_COLOR = "#a1a1aa";

interface Option {
  value: string;
  label: string;
  icon?: ReactNode;
}

function MultiSelect({
  label,
  icon: Icon,
  options,
  selected,
  onToggle,
}: {
  label: string;
  icon?: LucideIcon;
  options: Option[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Filter by ${label.toLowerCase()}`}>
          {Icon && <Icon />}
          {label}
          {selected.length > 0 && <span className="rounded-full bg-secondary px-1.5 text-xs">{selected.length}</span>}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Find ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem key={option.value} value={option.label} onSelect={() => onToggle(option.value)}>
                  {option.icon}
                  <span className="truncate">{option.label}</span>
                  {selected.includes(option.value) && <CheckIcon className="ml-auto size-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function FilterChip({ label, onRemove, children }: { label: string; onRemove: () => void; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-secondary/50 py-0.5 pr-0.5 pl-2 text-xs">
      {children}
      <span className="max-w-40 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove filter ${label}`}
        className="rounded-full p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

export function TaskFilterBar({
  filters,
  onChange,
  statuses,
  members,
  actors,
  tags,
  meId,
}: {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  statuses: StatusDto[];
  /** Active members: the options of the assignee filter. */
  members: ActorDto[];
  /** Everyone, deactivated too: to name chips. */
  actors: ActorDto[];
  tags: TagDto[];
  meId: string;
}) {
  // The text box is local and debounced into the URL; external changes (a saved view, Clear) reset it.
  const [text, setText] = useState(filters.q ?? "");
  useEffect(() => setText(filters.q ?? ""), [filters.q]);
  useEffect(() => {
    if (text.trim() === (filters.q ?? "")) return;
    const timer = setTimeout(() => onChange({ ...filters, q: text.trim() || undefined }), 250);
    return () => clearTimeout(timer);
  }, [text, filters, onChange]);

  const actorById = new Map([...actors, ...members].map((a) => [a.id, a]));
  const assigneeLabel = (value: string) => {
    if (value === "me") return "Me";
    if (value === "none") return "Unassigned";
    const actor = actorById.get(value);
    return actor ? actorLabel(actor) : "Unknown";
  };

  const assigneeOptions: Option[] = [
    { value: "me", label: "Me" },
    { value: "none", label: "Unassigned" },
    ...members.filter((m) => m.id !== meId).map((m) => ({ value: m.id, label: actorLabel(m) })),
  ];

  return (
    <div role="search" aria-label="Filter tasks" className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Filter by title or key"
          placeholder="Filter tasks…"
          className="h-8 w-48 pl-7"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <MultiSelect
        label="Status"
        options={statuses.map((s) => ({ value: s.id, label: s.name, icon: <StatusIcon status={s} /> }))}
        selected={filters.status ?? []}
        onToggle={(id) => onChange({ ...filters, status: toggleValue(filters.status, id) })}
      />
      <MultiSelect
        label="Assignee"
        options={assigneeOptions}
        selected={filters.assignee ?? []}
        onToggle={(id) => onChange({ ...filters, assignee: toggleValue(filters.assignee, id) })}
      />
      <MultiSelect
        label="Priority"
        options={PRIORITIES.map((p) => ({ value: String(p.value), label: p.label, icon: <PriorityIcon priority={p.value} /> }))}
        selected={(filters.priority ?? []).map(String)}
        onToggle={(value) => onChange({ ...filters, priority: toggleValue(filters.priority, Number(value) as Priority) })}
      />
      <MultiSelect
        label="Tag"
        options={tags.map((t) => ({
          value: t.id,
          label: t.name,
          icon: <span className="size-2 rounded-full" style={{ backgroundColor: t.color ?? FALLBACK_COLOR }} />,
        }))}
        selected={filters.tag ?? []}
        onToggle={(id) => onChange({ ...filters, tag: toggleValue(filters.tag, id) })}
      />
      {!isEmptyFilters(filters) && (
        <>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          {filters.status?.map((id) => {
            const status = statuses.find((s) => s.id === id);
            return (
              <FilterChip key={`s-${id}`} label={status?.name ?? "Unknown status"} onRemove={() => onChange({ ...filters, status: toggleValue(filters.status, id) })}>
                {status && <StatusIcon status={status} className="size-3" />}
              </FilterChip>
            );
          })}
          {filters.assignee?.map((value) => (
            <FilterChip key={`a-${value}`} label={assigneeLabel(value)} onRemove={() => onChange({ ...filters, assignee: toggleValue(filters.assignee, value) })} />
          ))}
          {filters.priority?.map((value) => (
            <FilterChip
              key={`p-${value}`}
              label={PRIORITIES.find((p) => p.value === value)?.label ?? String(value)}
              onRemove={() => onChange({ ...filters, priority: toggleValue(filters.priority, value) })}
            >
              <PriorityIcon priority={value} className="size-3" />
            </FilterChip>
          ))}
          {filters.tag?.map((id) => {
            const tag = tags.find((t) => t.id === id);
            return (
              <FilterChip key={`t-${id}`} label={tag?.name ?? "Unknown tag"} onRemove={() => onChange({ ...filters, tag: toggleValue(filters.tag, id) })}>
                <span className="size-1.5 rounded-full" style={{ backgroundColor: tag?.color ?? FALLBACK_COLOR }} />
              </FilterChip>
            );
          })}
          {filters.q && <FilterChip label={`“${filters.q}”`} onRemove={() => onChange({ ...filters, q: undefined })} />}
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            Clear
          </Button>
        </>
      )}
    </div>
  );
}
