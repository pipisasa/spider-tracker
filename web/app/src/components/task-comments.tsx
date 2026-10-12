import { CommentBody } from "@/components/comment-body";
import { RELATION_LABELS } from "@/components/relations";
import { ActorAvatar, formatDay } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/mention-textarea";
import { mentionOf, nameOf } from "@/lib/assignees";
import { actorsQuery, activityQuery, commentsQuery, tagsQuery, useAddComment } from "@/lib/work";
import type {
  ActivityDto,
  ActorDto,
  CommentDto,
  RelationKind,
  StatusDto,
} from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, HistoryIcon, ReplyIcon } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});


const PRIORITY_LABELS = ["no priority", "urgent", "high", "medium", "low"];

/** One line describing an activity entry, e.g. "changed status Todo → In Progress". */
export function describeActivity(
  entry: ActivityDto,
  statuses: StatusDto[],
  members: Map<string, ActorDto>,
  tags: Map<string, string> = new Map(),
): string | null {
  const statusName = (id: unknown) =>
    statuses.find((s) => s.id === id)?.name ?? "unknown";
  const names = (ids: unknown) =>
    Array.isArray(ids) && ids.length > 0
      ? ids
          .map((id) => mentionOf(members.get(String(id))))
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
  // Releases (ST-93): a release marked Released ships its tasks; moving it back undoes that.
  if ((entry.action === "task.shipped" || entry.action === "task.unshipped") && entry.changes) {
    const version = String(entry.changes.version ?? entry.changes.release ?? "a release");
    return entry.action === "task.shipped" ? `shipped in ${version}` : `no longer shipped in ${version}`;
  }
  // Deployments (ST-94): "deployed web to staging at 3f2c1ab".
  if (entry.action === "release.deployed" && entry.changes) {
    const { app, environment, commitSha } = entry.changes;
    // An app in a repo the viewer can't see comes without its details.
    if (typeof app !== "string") return "deployed an app";
    return `deployed ${app} to ${String(environment)} at ${String(commitSha).slice(0, 7)}`;
  }
  if (entry.action !== "task.updated" || !entry.changes) return null;
  const parts: string[] = [];
  let cause: string | null = null;
  for (const [field, value] of Object.entries(entry.changes)) {
    const [from, to] = Array.isArray(value) ? value : [undefined, value];
    // Not a field: the pull request event that moved the task (ST-85).
    if (field === "pullRequest") cause = describePullRequestCause(value);
    else if (field === "statusId")
      parts.push(`moved ${statusName(from)} → ${statusName(to)}`);
    else if (field === "assigneeIds") parts.push(`assigned ${names(to)}`);
    else if (field === "priority")
      parts.push(`set priority to ${PRIORITY_LABELS[Number(to)] ?? to}`);
    else if (field === "title") parts.push("renamed the task");
    else if (field === "description") parts.push("edited the description");
    else if (field === "parentId")
      parts.push(to ? "set a parent task" : "removed the parent task");
    else if (field === "tagIds") parts.push(describeTagChange(from, to, tags));
    else if (field === "releaseId") parts.push(to ? "added it to a release" : "took it out of its release");
    else if (field === "noCode") parts.push(to ? "marked it as having no code" : "marked it as having code");
    else if (field === "apps" || field === "repos") {
      const list = Array.isArray(to) && to.length > 0 ? to.map(String).join(", ") : "none";
      parts.push(`set the ${field} to ${list}`);
    }
    else if (field === "startDate" || field === "targetDate") {
      const name = field === "startDate" ? "start date" : "target date";
      parts.push(typeof to === "string" ? `set the ${name} to ${formatDay(to)}` : `removed the ${name}`);
    }
    else parts.push(`changed ${field}`);
  }
  const line = parts.join(", ");
  return (line && cause ? `${line} ${cause}` : line) || null;
}

const PULL_REQUEST_EVENTS: Record<string, string> = {
  opened: "opened",
  draft: "marked as a draft",
  merged: "merged",
  closed: "closed",
};

/** "(pull request #12 merged by bob)", from status automation's activity context. */
function describePullRequestCause(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { number, event, sender } = value as Record<string, unknown>;
  if (typeof number !== "number" || typeof event !== "string") return null;
  const by = typeof sender === "string" && sender ? ` by ${sender}` : "";
  return `(pull request #${number} ${PULL_REQUEST_EVENTS[event] ?? event}${by})`;
}

/** "added tag bug", "added tags bug, ui and removed 1 deleted tag". */
function describeTagChange(from: unknown, to: unknown, tags: Map<string, string>): string {
  const before = Array.isArray(from) ? from.map(String) : [];
  const after = Array.isArray(to) ? to.map(String) : [];
  const phrase = (verb: string, ids: string[]) => {
    if (ids.length === 0) return null;
    const names = ids.flatMap((id) => tags.get(id) ?? []);
    const gone = ids.length - names.length;
    const parts = [
      names.length > 0 ? `${names.length > 1 ? "tags" : "tag"} ${names.join(", ")}` : null,
      gone > 0 ? `${gone} deleted ${gone > 1 ? "tags" : "tag"}` : null,
    ].filter((part) => part !== null);
    return `${verb} ${parts.join(" and ")}`;
  };
  const bits = [
    phrase("added", after.filter((id) => !before.includes(id))),
    phrase("removed", before.filter((id) => !after.includes(id))),
  ].filter((bit) => bit !== null);
  return bits.length > 0 ? bits.join(", ") : "changed tags";
}

type TimelineItem =
  { at: string; comment: CommentDto } | { at: string; activity: ActivityDto };

/** A comment box with @-mention suggestions; ⌘↵ sends. */
export function CommentForm({
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

/** One comment; `actions` sit next to Reply (document comments add Resolve). */
export function CommentItem({
  comment,
  author,
  handles,
  onReply,
  actions,
}: {
  comment: Pick<CommentDto, "body" | "createdAt">;
  author: ActorDto | undefined;
  handles: Set<string>;
  onReply?: () => void;
  actions?: ReactNode;
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
            {nameOf(author, "Unknown")}
          </span>
          {author?.type === "agent" && (
            <BotIcon className="size-3" aria-label="agent" />
          )}
          <span>{timeFormat.format(new Date(comment.createdAt))}</span>
          <span className="ml-auto flex items-center gap-1">
            {actions}
            {onReply && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={onReply}
              >
                <ReplyIcon /> Reply
              </Button>
            )}
          </span>
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
  const { data: tagList = [] } = useQuery(tagsQuery(orgSlug));
  const tagNames = useMemo(() => new Map(tagList.map((t) => [t.id, t.name])), [tagList]);
  const add = useAddComment(orgSlug, taskKey);
  // The comment being replied to; its thread shows the reply box.
  const [replyTo, setReplyTo] = useState<CommentDto | null>(null);
  // Naming uses every actor, deactivated ones included; mentions use only the active `members`.
  const { data: actors = [] } = useQuery(actorsQuery(orgSlug));
  const byId = useMemo(
    () => new Map([...actors, ...members].map((m) => [m.id, m])),
    [actors, members],
  );
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
            const text = describeActivity(item.activity, statuses, byId, tagNames);
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
                    {nameOf(actor, "Someone")}
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
