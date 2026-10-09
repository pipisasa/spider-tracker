import { ActorAvatar } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { commentsQuery, useAddComment } from "@/lib/work";
import type { ActorDto } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon } from "lucide-react";
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

export function TaskComments({ orgSlug, taskKey, members }: { orgSlug: string; taskKey: string; members: ActorDto[] }) {
  const { data: comments = [] } = useQuery(commentsQuery(orgSlug, taskKey));
  const add = useAddComment(orgSlug, taskKey);
  const [draft, setDraft] = useState("");
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const handles = useMemo(() => new Set(members.map((m) => m.handle)), [members]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim()) return;
    add.mutate(draft, { onSuccess: () => setDraft(""), onError: (err) => toast.error(err.message) });
  }

  return (
    <section className="flex flex-col gap-4 border-t pt-4">
      <h2 className="text-sm font-medium text-muted-foreground">Comments</h2>
      {comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      <ul className="flex flex-col gap-4">
        {comments.map((c) => {
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
