import { Button } from "@/components/ui/button";
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
import { tagsQuery, useCreateTag } from "@/lib/work";
import type { TagDto } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, PlusIcon, TagIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// Tag chips and the tag picker (ST-8).

const FALLBACK_COLOR = "#a1a1aa";
const PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#6366f1",
  "#a855f7",
  "#ec4899",
];

export function TagChips({
  tagIds,
  tags,
  className,
}: {
  tagIds?: string[];
  tags: TagDto[];
  className?: string;
}) {
  // Optional so a web build that's newer than the API (during a deploy) still renders.
  const chosen = (tagIds ?? [])
    .map((id) => tags.find((t) => t.id === id))
    .filter((t): t is TagDto => !!t);
  if (chosen.length === 0) return null;
  return (
    <span className={`flex flex-wrap gap-1 ${className ?? ""}`}>
      {chosen.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground"
        >
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: tag.color ?? FALLBACK_COLOR }}
          />
          {tag.name}
        </span>
      ))}
    </span>
  );
}

export function TagPicker({
  orgSlug,
  value,
  onChange,
}: {
  orgSlug: string;
  value: string[];
  onChange: (tagIds: string[]) => void;
}) {
  const { data: tags = [] } = useQuery(tagsQuery(orgSlug));
  const create = useCreateTag(orgSlug);
  const [search, setSearch] = useState("");
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    );
  const exact = tags.some(
    (t) => t.name.toLowerCase() === search.trim().toLowerCase(),
  );

  function createTag() {
    const name = search.trim();
    if (!name) return;
    create.mutate(
      { name, color: PALETTE[tags.length % PALETTE.length] },
      {
        onSuccess: (tag) => {
          onChange([...value, tag.id]);
          setSearch("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-auto min-h-9 w-full justify-start gap-2 font-normal"
          aria-label="Tags"
        >
          {value.length === 0 ? (
            <>
              <TagIcon className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">No tags</span>
            </>
          ) : (
            <TagChips tagIds={value} tags={tags} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Find or create a tag…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No tags yet.</CommandEmpty>
            <CommandGroup>
              {tags.map((tag) => (
                <CommandItem
                  key={tag.id}
                  value={tag.name}
                  onSelect={() => toggle(tag.id)}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: tag.color ?? FALLBACK_COLOR }}
                  />
                  {tag.name}
                  {value.includes(tag.id) && (
                    <CheckIcon className="ml-auto size-4" />
                  )}
                </CommandItem>
              ))}
              {search.trim() && !exact && (
                <CommandItem
                  value={`create ${search}`}
                  onSelect={createTag}
                  disabled={create.isPending}
                >
                  <PlusIcon className="size-4" />
                  Create “{search.trim()}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
