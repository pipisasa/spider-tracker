import { StatusIcon } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { relationsQuery, useRelation } from "@/lib/work";
import type { RelationKind, StatusDto } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

// Links to other tasks (ST-10), as seen from this task.

const LABELS: Record<RelationKind, string> = {
  blocked_by: "Blocked by",
  blocks: "Blocks",
  duplicates: "Duplicates",
  duplicated_by: "Duplicated by",
  relates: "Related to",
};

export function Relations({ orgSlug, taskKey, statuses }: { orgSlug: string; taskKey: string; statuses: StatusDto[] }) {
  const { data: relations = [] } = useQuery(relationsQuery(orgSlug, taskKey));
  const mutate = useRelation(orgSlug, taskKey);
  const [kind, setKind] = useState<RelationKind>("relates");
  const [other, setOther] = useState("");

  function add(event: FormEvent) {
    event.preventDefault();
    const task = other.trim().toUpperCase();
    if (!task) return;
    mutate.mutate(
      { add: true, kind, task },
      { onSuccess: () => setOther(""), onError: (err) => toast.error(err.message) },
    );
  }

  const kinds = Object.keys(LABELS) as RelationKind[];
  const groups = kinds.map((k) => ({ kind: k, items: relations.filter((r) => r.kind === k) })).filter((g) => g.items.length);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Links</h2>
      {groups.map((group) => (
        <div key={group.kind} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{LABELS[group.kind]}</span>
          <ul className="divide-y rounded-lg border">
            {group.items.map((r) => {
              const status = statuses.find((s) => s.id === r.task.statusId);
              return (
                <li key={`${r.kind}-${r.task.id}`} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                  {status && <StatusIcon status={status} />}
                  <Link
                    to="/$orgSlug/tasks/$taskKey"
                    params={{ orgSlug, taskKey: r.task.key }}
                    className="flex min-w-0 flex-1 gap-3 hover:underline"
                  >
                    <span className="w-16 shrink-0 text-muted-foreground">{r.task.key}</span>
                    <span className="truncate">{r.task.title}</span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Remove link to ${r.task.key}`}
                    onClick={() =>
                      mutate.mutate({ add: false, kind: r.kind, task: r.task.key }, { onError: (err) => toast.error(err.message) })
                    }
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <form onSubmit={add} className="flex gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as RelationKind)}>
          <SelectTrigger className="w-36" aria-label="Link kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Task key to link"
          placeholder="Task key, e.g. ST-12"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={mutate.isPending || !other.trim()}>
          Link
        </Button>
      </form>
    </section>
  );
}
