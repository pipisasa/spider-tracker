import { CommentBody } from "@/components/comment-body";
import { RELATION_LABELS } from "@/components/relations";
import { ActorAvatar } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/mention-textarea";
import { activityQuery, commentsQuery, useAddComment } from "@/lib/work";
import type {
  ActivityDto,
  ActorDto,
  CommentDto,
  RelationKind,
  StatusDto,
} from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, HistoryIcon, ReplyIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});


const PRIORITY_LABELS = ["no priority", "urgent", "high", "medium", "low"];

/** One line describing an activity entry, e.g. "changed status Todo → In Progress". */
function describeActivity(
  entry: ActivityDto,
  statuses: StatusDto[],
  members: Map<string, ActorDto>,
): string | null {
  const statusName = (id: unknown) =>
    statuses.find((s) => s.id === id)?.name ?? "unknown";
  const names = (ids: unknown) =>
    Array.isArray(ids) && ids.length > 0
      ? ids
          .map((id) => `@${members.get(String(id))?.handle ?? "unknown"}`)
          .join(", ")
      : "nobody";
  if (entry.action === "task.created") return "created the task";
  if (entry.action === "task.deleted") return "deleted the task";
  if ((entry.action === "relation.added" || entry.action === "relation.removed") && entry.changes) {
    const { kind, task } = entry.changes;
    const label = typeof kind === "string" && kind in RELATION_LABELS ? RELATION_LABELS[kind as RelationKind] : "Linked to";
    const verb = entry.action === "relation.added" ? "added link" : "removed link";
    return `${verb}: ${label.toLowerCase()} ${String(task)}`;
  }
  if (entry.action !== "task.updated" || !entry.changes) return null;
  const parts: string[] = [];
  for (const [field, value] of Object.entries(entry.changes)) {
    const [from, to] = Array.isArray(value) ? value : [undefined, value];
    if (field === "statusId")
      parts.push(`moved ${statusName(from)} → ${statusName(to)}`);
    else if (field === "assigneeIds") parts.push(`assigned ${names(to)}`);
    else if (field === "priority")
      parts.push(`set priority to ${PRIORITY_LABELS[Number(to)] ?? to}`);
    else if (field === "title") parts.push("renamed the task");
    else if (field === "description") parts.push("edited the description");
    else if (field === "parentId")
      parts.push(to ? "set a parent task" : "removed the parent task");
    else parts.push(`changed ${field}`);
  }
  return parts.join(", ") || null;
}

type TimelineItem =
  { at: string; comment: CommentDto } | { at: string; activity: ActivityDto };

/** A comment box with @-mention suggestions; ⌘↵ sends. */
function CommentForm({
  members,
  pending,
  label,
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  members: ActorDto[];
  pending: boolean;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState("");

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (draft.trim()) onSubmit(draft, () => setDraft(""));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <MentionTextarea
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        autoFocus={autoFocus}
        members={members}
        value={draft}
        onValueChange={setDraft}
        onFocus={(e) =>
          e.currentTarget.setSelectionRange(draft.length, draft.length)
        }
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel?.();
        }}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
          {label}
        </Button>
      </div>
    </form>
  );
}

function CommentItem({
  comment,
  author,
  handles,
  onReply,
}: {
  comment: CommentDto;
  author: ActorDto | undefined;
  handles: Set<string>;
  onReply: () => void;
}) {
  return (
    <div className="group flex gap-3">
      {author ? (
        <ActorAvatar actor={author} className="size-7" />
      ) : (
        <span className="size-7 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {author?.name ?? "Unknown"}
          </span>
          {author?.type === "agent" && (
            <BotIcon className="size-3" aria-label="agent" />
          )}
          <span>{timeFormat.format(new Date(comment.createdAt))}</span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onReply}
          >
            <ReplyIcon /> Reply
          </Button>
        </div>
        <CommentBody body={comment.body} handles={handles} />
      </div>
    </div>
  );
}

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
  // The comment being replied to; its thread shows the reply box.
  const [replyTo, setReplyTo] = useState<CommentDto | null>(null);
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const handles = useMemo(
    () => new Set(members.map((m) => m.handle)),
    [members],
  );
  // Replies (at any depth) sit under their top-level comment, oldest first.
  const { roots, replies, rootOf } = useMemo(() => {
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const rootOf = (c: CommentDto): string => {
      const parent = c.parentId ? commentById.get(c.parentId) : undefined;
      return parent ? rootOf(parent) : c.id;
    };
    const replies = new Map<string, CommentDto[]>();
    const roots: CommentDto[] = [];
    for (const c of comments) {
      const root = rootOf(c);
      if (root === c.id) roots.push(c);
      else replies.set(root, [...(replies.get(root) ?? []), c]);
    }
    return { roots, replies, rootOf };
  }, [comments]);
  // Comments carry their own entry; their "comment.created" activity rows would only repeat them.
  const timeline = useMemo<TimelineItem[]>(
    () =>
      [
        ...roots.map((comment) => ({ at: comment.createdAt, comment })),
        ...activity
          .filter((a) => a.action !== "comment.created")
          .map((a) => ({ at: a.createdAt, activity: a })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [roots, activity],
  );

  function send(body: string, reset: () => void, parentId?: string) {
    add.mutate(
      { body, parentId },
      {
        onSuccess: () => {
          reset();
          setReplyTo(null);
        },
        onError: (err) => toast.error(err.message),
      },
    );
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
              <li
                key={`a${item.activity.id}`}
                className="flex items-center gap-2 pl-1 text-xs text-muted-foreground"
              >
                <HistoryIcon className="size-3.5 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">
                    {actor?.name ?? "Someone"}
                  </span>{" "}
                  {text}
                  {item.activity.source !== "ui" &&
                    ` · via ${item.activity.source}`}
                  {" · "}
                  {timeFormat.format(new Date(item.at))}
                </span>
              </li>
            );
          }
          const c = item.comment;
          const thread = replies.get(c.id) ?? [];
          const replyingHere = replyTo !== null && rootOf(replyTo) === c.id;
          return (
            <li key={c.id} className="flex flex-col gap-3">
              <CommentItem
                comment={c}
                author={byId.get(c.authorId)}
                handles={handles}
                onReply={() => setReplyTo(c)}
              />
              {(thread.length > 0 || replyingHere) && (
                <div className="ml-3.5 flex flex-col gap-3 border-l pl-6">
                  {thread.map((r) => (
                    <CommentItem
                      key={r.id}
                      comment={r}
                      author={byId.get(r.authorId)}
                      handles={handles}
                      onReply={() => setReplyTo(r)}
                    />
                  ))}
                  {replyingHere && (
                    <CommentForm
                      key={replyTo.id}
                      members={members}
                      pending={add.isPending}
                      label="Reply"
                      placeholder={`Reply to ${byId.get(replyTo.authorId)?.name ?? "comment"}…`}
                      autoFocus
                      onSubmit={(body, reset) => send(body, reset, replyTo.id)}
                      onCancel={() => setReplyTo(null)}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <CommentForm
        members={members}
        pending={add.isPending && !replyTo}
        label="Comment"
        placeholder="Leave a comment… type @ to mention people and agents (⌘↵ to send)"
        onSubmit={(body, reset) => send(body, reset)}
      />
    </section>
  );
}
