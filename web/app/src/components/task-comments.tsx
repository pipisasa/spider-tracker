import { ActorAvatar } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { activityQuery, commentsQuery, useAddComment } from "@/lib/work";
import type { ActivityDto, ActorDto, CommentDto, StatusDto } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, HistoryIcon } from "lucide-react";
import { Fragment, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Plain text with @handles of known members highlighted. */
function Body({ body, handles }: { body: string; handles: Set<string> }) {
  const parts = body.split(/(@[a-z0-9]+(?:-[a-z0-9]+)*)/gi);
  return (
    <p className="text-sm whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.startsWith("@") && handles.has(part.slice(1).toLowerCase()) ? (
          <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

const PRIORITY_LABELS = ["no priority", "urgent", "high", "medium", "low"];

/** One line describing an activity entry, e.g. "changed status Todo → In Progress". */
function describeActivity(entry: ActivityDto, statuses: StatusDto[], members: Map<string, ActorDto>): string | null {
  const statusName = (id: unknown) => statuses.find((s) => s.id === id)?.name ?? "unknown";
  const names = (ids: unknown) =>
    Array.isArray(ids) && ids.length > 0 ? ids.map((id) => `@${members.get(String(id))?.handle ?? "unknown"}`).join(", ") : "nobody";
  if (entry.action === "task.created") return "created the task";
  if (entry.action === "task.deleted") return "deleted the task";
  if (entry.action !== "task.updated" || !entry.changes) return null;
  const parts: string[] = [];
  for (const [field, value] of Object.entries(entry.changes)) {
    const [from, to] = Array.isArray(value) ? value : [undefined, value];
    if (field === "statusId") parts.push(`moved ${statusName(from)} → ${statusName(to)}`);
    else if (field === "assigneeIds") parts.push(`assigned ${names(to)}`);
    else if (field === "priority") parts.push(`set priority to ${PRIORITY_LABELS[Number(to)] ?? to}`);
    else if (field === "title") parts.push("renamed the task");
    else if (field === "description") parts.push("edited the description");
    else if (field === "parentId") parts.push(to ? "set a parent task" : "removed the parent task");
    else parts.push(`changed ${field}`);
  }
  return parts.join(", ") || null;
}

type TimelineItem = { at: string; comment: CommentDto } | { at: string; activity: ActivityDto };

export function TaskComments({
  orgSlug,
  taskKey,
  members,
  statuses,
}: {
  orgSlug: string;
  taskKey: string;
  members: ActorDto[];
  statuses: StatusDto[];
}) {
  const { data: comments = [] } = useQuery(commentsQuery(orgSlug, taskKey));
  const { data: activity = [] } = useQuery(activityQuery(orgSlug, taskKey));
  const add = useAddComment(orgSlug, taskKey);
  const [draft, setDraft] = useState("");
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const handles = useMemo(() => new Set(members.map((m) => m.handle)), [members]);
  // Comments carry their own entry; their "comment.created" activity rows would only repeat them.
  const timeline = useMemo<TimelineItem[]>(
    () =>
      [
        ...comments.map((comment) => ({ at: comment.createdAt, comment })),
        ...activity.filter((a) => a.action !== "comment.created").map((a) => ({ at: a.createdAt, activity: a })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [comments, activity],
  );

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim()) return;
    add.mutate(draft, { onSuccess: () => setDraft(""), onError: (err) => toast.error(err.message) });
  }

  return (
    <section className="flex flex-col gap-4 border-t pt-4">
      <h2 className="text-sm font-medium text-muted-foreground">Activity</h2>
      <ul className="flex flex-col gap-4">
        {timeline.map((item) => {
          if ("activity" in item) {
            const text = describeActivity(item.activity, statuses, byId);
            if (!text) return null;
            const actor = byId.get(item.activity.actorId);
            return (
              <li key={`a${item.activity.id}`} className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                <HistoryIcon className="size-3.5 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">{actor?.name ?? "Someone"}</span> {text}
                  {item.activity.source !== "ui" && ` · via ${item.activity.source}`}
                  {" · "}
                  {timeFormat.format(new Date(item.at))}
                </span>
              </li>
            );
          }
          const c = item.comment;
          const author = byId.get(c.authorId);
          return (
            <li key={c.id} className="flex gap-3">
              {author ? <ActorAvatar actor={author} className="size-7" /> : <span className="size-7" />}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{author?.name ?? "Unknown"}</span>
                  {author?.type === "agent" && <BotIcon className="size-3" aria-label="agent" />}
                  <span>{timeFormat.format(new Date(c.createdAt))}</span>
                </div>
                <Body body={c.body} handles={handles} />
              </div>
            </li>
          );
        })}
      </ul>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Textarea
          aria-label="New comment"
          placeholder="Leave a comment… @handle notifies people and agents (⌘↵ to send)"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <Button type="submit" size="sm" className="self-end" disabled={add.isPending || !draft.trim()}>
          Comment
        </Button>
      </form>
    </section>
  );
}
