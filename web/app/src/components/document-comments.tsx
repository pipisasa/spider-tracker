import { CommentForm, CommentItem } from "@/components/task-comments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { nameOf } from "@/lib/assignees";
import { cn } from "@/lib/utils";
import {
  actorsQuery,
  documentCommentsQuery,
  membersQuery,
  useAddDocumentComment,
  useResolveDocumentComment,
} from "@/lib/work";
import { skeleton, skeletonIndex } from "@repo/core/anchors";
import type { DocumentCommentDto } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  MessageSquarePlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

// Comments on a document (ST-118): threads on the whole document or on a quoted fragment, which
// is highlighted in the rendered Markdown (CSS Custom Highlight API: the DOM React renders is
// never touched). A quote whose text changed is "outdated"; a thread can be resolved.

/** Highlight names, styled in styles.css. */
const HIGHLIGHT = "doc-comment";
const HIGHLIGHT_ACTIVE = "doc-comment-active";

/** The longest quote the API takes. */
const MAX_QUOTE = 2_000;

/** A thread: its first comment and the replies under it (at any depth), oldest first. */
export interface CommentThread {
  root: DocumentCommentDto;
  replies: DocumentCommentDto[];
}

export function threadsOf(comments: DocumentCommentDto[]): CommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: DocumentCommentDto, depth = 0): string => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    return parent && depth < comments.length ? rootOf(parent, depth + 1) : c.id;
  };
  const threads = new Map<string, CommentThread>();
  for (const c of comments) {
    const root = rootOf(c);
    if (root === c.id) threads.set(c.id, { root: c, replies: threads.get(c.id)?.replies ?? [] });
    else {
      const thread = threads.get(root);
      if (thread) thread.replies.push(c);
    }
  }
  return [...threads.values()];
}

/** A position in a list of text pieces: which piece, and the offset inside it. */
export interface TextPoint {
  piece: number;
  offset: number;
}

/**
 * Where `quote` sits in text split into pieces (a node's text nodes), matched as the API matches
 * it: letters and digits only. Null when it isn't there.
 */
export function locateQuote(pieces: string[], quote: string): { start: TextPoint; end: TextPoint } | null {
  const needle = skeleton(quote);
  if (!needle || pieces.length === 0) return null;
  const starts: number[] = [];
  let text = "";
  for (const piece of pieces) {
    starts.push(text.length);
    text += piece;
  }
  const index = skeletonIndex(text);
  const at = index.skeleton.indexOf(needle);
  if (at < 0) return null;
  const first = index.offsets[at];
  const last = index.offsets[at + needle.length - 1];
  if (first === undefined || last === undefined) return null;
  const end = last + ((text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1);
  // The start lies in the piece holding its character; the (exclusive) end in the piece holding the last one.
  const pieceOf = (offset: number) => {
    let i = 0;
    while (i + 1 < pieces.length && (starts[i + 1] ?? 0) <= offset) i++;
    return i;
  };
  const startPiece = pieceOf(first);
  const endPiece = pieceOf(end - 1);
  return {
    start: { piece: startPiece, offset: first - (starts[startPiece] ?? 0) },
    end: { piece: endPiece, offset: end - (starts[endPiece] ?? 0) },
  };
}

/** The DOM range of `quote` in the text under `root`. */
export function findQuote(root: Node, quote: string): Range | null {
  const doc = root.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  const found = locateQuote(nodes.map((n) => n.data), quote);
  const startNode = found && nodes[found.start.piece];
  const endNode = found && nodes[found.end.piece];
  if (!found || !startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, found.start.offset);
  range.setEnd(endNode, found.end.offset);
  return range;
}

const highlights = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
    ? CSS.highlights
    : null;

/**
 * Highlights the quotes of open, current threads in `container`; a click on one activates its
 * thread. Re-finds them when the rendered text changes (wiki-link labels arrive late).
 */
export function useQuoteHighlights(
  container: HTMLElement | null,
  threads: CommentThread[],
  active: string | null,
  onActivate: (id: string) => void,
) {
  const [ranges, setRanges] = useState<Map<string, Range>>(() => new Map());

  // Find the quotes now and whenever the rendered text changes.
  useEffect(() => {
    const el = container;
    if (!el) return;
    const find = () => {
      const found = new Map<string, Range>();
      for (const { root } of threads) {
        if (!root.quote || root.outdated || root.resolvedAt) continue;
        const range = findQuote(el, root.quote);
        if (range) found.set(root.id, range);
      }
      setRanges(found);
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [container, threads]);

  useEffect(() => {
    const registry = highlights();
    if (!registry) return;
    const others = [...ranges.entries()].filter(([id]) => id !== active).map(([, r]) => r);
    registry.set(HIGHLIGHT, new Highlight(...others));
    const current = active ? ranges.get(active) : undefined;
    registry.set(HIGHLIGHT_ACTIVE, new Highlight(...(current ? [current] : [])));
    return () => {
      registry.delete(HIGHLIGHT);
      registry.delete(HIGHLIGHT_ACTIVE);
    };
  }, [ranges, active]);

  // Bring a newly activated thread's fragment into view (once per activation).
  const [scrolledTo, setScrolledTo] = useState<string | null>(null);
  useEffect(() => {
    if (!active || active === scrolledTo) return;
    const range = ranges.get(active);
    if (!range) return;
    range.startContainer.parentElement?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setScrolledTo(active);
  }, [active, ranges, scrolledTo]);

  // A click on a highlighted fragment opens its thread.
  useEffect(() => {
    const el = container;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!caret) return;
      for (const [id, range] of ranges) {
        if (range.isPointInRange(caret.startContainer, caret.startOffset)) {
          onActivate(id);
          return;
        }
      }
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [container, ranges, onActivate]);
}

/** A "Comment" button over a text selection inside `container`. */
export function SelectionCommentButton({
  container,
  onComment,
}: {
  container: HTMLElement | null;
  onComment: (quote: string) => void;
}) {
  const [at, setAt] = useState<{ top: number; left: number; quote: string } | null>(null);

  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const el = container;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !el) return setAt(null);
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setAt(null);
      const quote = selection.toString().replace(/\s+/g, " ").trim();
      if (!quote || !skeleton(quote)) return setAt(null);
      const rect = range.getBoundingClientRect();
      setAt({ top: rect.bottom + 6, left: rect.left + rect.width / 2, quote: quote.slice(0, MAX_QUOTE) });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [container]);

  if (!at) return null;
  return (
    <Button
      size="sm"
      className="fixed z-50 -translate-x-1/2 shadow-md"
      style={{ top: at.top, left: at.left }}
      // Keep the selection while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onComment(at.quote);
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
    >
      <MessageSquarePlusIcon />
      Comment
    </Button>
  );
}

/** The comments panel: a new-comment box (with the quote being commented on) and the threads. */
export function DocumentComments({
  orgSlug,
  documentId,
  canWrite,
  quote,
  onClearQuote,
  active,
  onActivate,
}: {
  orgSlug: string;
  documentId: string;
  canWrite: boolean;
  /** The fragment picked for a new comment, if any. */
  quote: string | null;
  onClearQuote: () => void;
  active: string | null;
  onActivate: (id: string | null) => void;
}) {
  const { data: comments = [] } = useQuery(documentCommentsQuery(orgSlug, documentId));
  const { data: members = [] } = useQuery(membersQuery(orgSlug));
  const { data: actors = [] } = useQuery(actorsQuery(orgSlug));
  const add = useAddDocumentComment(orgSlug, documentId);
  const resolve = useResolveDocumentComment(orgSlug, documentId);
  const [replyTo, setReplyTo] = useState<DocumentCommentDto | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const byId = useMemo(() => new Map([...actors, ...members].map((m) => [m.id, m])), [actors, members]);
  const handles = useMemo(() => new Set(members.map((m) => m.handle)), [members]);
  const threads = useMemo(() => threadsOf(comments), [comments]);
  const open = threads.filter((t) => !t.root.resolvedAt);
  const resolved = threads.filter((t) => t.root.resolvedAt);

  function send(body: string, reset: () => void, parentId?: string) {
    add.mutate(
      parentId ? { body, parentId } : { body, quote },
      {
        onSuccess: (comment) => {
          reset();
          setReplyTo(null);
          if (!parentId) {
            onClearQuote();
            onActivate(comment.id);
          }
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function setResolved(thread: CommentThread, value: boolean) {
    resolve.mutate(
      { commentId: thread.root.id, resolved: value },
      { onError: (err) => toast.error(err.message) },
    );
  }

  const renderThread = (thread: CommentThread) => {
    const { root } = thread;
    const replying = replyTo !== null && (replyTo.id === root.id || thread.replies.some((r) => r.id === replyTo.id));
    const resolver = root.resolvedBy ? byId.get(root.resolvedBy) : undefined;
    return (
      <li
        key={root.id}
        aria-current={active === root.id}
        className={cn(
          "flex flex-col gap-3 rounded-lg border p-3 transition-colors",
          active === root.id && "border-primary/60 bg-primary/5",
          root.resolvedAt && "opacity-75",
        )}
        onClick={() => onActivate(root.id)}
      >
        {root.quote && (
          <div className="flex flex-col gap-1">
            <blockquote
              className={cn(
                "line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground",
                root.outdated ? "border-muted-foreground/40 line-through decoration-muted-foreground/40" : "border-amber-400",
              )}
            >
              {root.quote}
            </blockquote>
            {root.outdated && (
              <Badge variant="outline" className="text-muted-foreground" title={`Commented on version ${root.documentVersion}; this text has changed since`}>
                Outdated
              </Badge>
            )}
          </div>
        )}
        <CommentItem
          comment={root}
          author={byId.get(root.authorId)}
          handles={handles}
          onReply={canWrite ? () => setReplyTo(root) : undefined}
          actions={
            canWrite && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={resolve.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  setResolved(thread, !root.resolvedAt);
                }}
              >
                {root.resolvedAt ? <RotateCcwIcon /> : <CheckIcon />}
                {root.resolvedAt ? "Reopen" : "Resolve"}
              </Button>
            )
          }
        />
        {(thread.replies.length > 0 || replying) && (
          <div className="ml-3.5 flex flex-col gap-3 border-l pl-4">
            {thread.replies.map((r) => (
              <CommentItem
                key={r.id}
                comment={r}
                author={byId.get(r.authorId)}
                handles={handles}
                onReply={canWrite ? () => setReplyTo(r) : undefined}
              />
            ))}
            {replying && (
              <CommentForm
                key={replyTo.id}
                members={members}
                pending={add.isPending}
                label="Reply"
                placeholder={`Reply to ${nameOf(byId.get(replyTo.authorId), "comment")}…`}
                autoFocus
                onSubmit={(body, reset) => send(body, reset, replyTo.id)}
                onCancel={() => setReplyTo(null)}
              />
            )}
          </div>
        )}
        {root.resolvedAt && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <CheckIcon className="size-3" />
            Resolved by {nameOf(resolver, "someone")}
          </p>
        )}
      </li>
    );
  };

  return (
    <section aria-labelledby="comments-heading" className="flex flex-col gap-3">
      <h2 id="comments-heading" className="text-sm font-medium text-muted-foreground">
        Comments{open.length > 0 && ` · ${open.length} open`}
      </h2>
      {canWrite && (
        <div className="flex flex-col gap-2">
          {quote ? (
            <div className="flex items-start gap-2 rounded-md bg-muted/60 p-2">
              <blockquote className="line-clamp-4 flex-1 border-l-2 border-amber-400 pl-2 text-xs text-muted-foreground">
                {quote}
              </blockquote>
              <Button variant="ghost" size="icon-xs" aria-label="Comment on the whole document instead" onClick={onClearQuote}>
                <XIcon />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Select text in the document to comment on a fragment.</p>
          )}
          <CommentForm
            key={quote ?? ""}
            members={members}
            pending={add.isPending && !replyTo}
            label="Comment"
            placeholder={quote ? "Comment on this fragment… (⌘↵ to send)" : "Comment on the document… type @ to mention (⌘↵ to send)"}
            autoFocus={quote !== null}
            onSubmit={(body, reset) => send(body, reset)}
          />
        </div>
      )}
      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">{open.map(renderThread)}</ul>
      )}
      {resolved.length > 0 && (
        <>
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </Button>
          {showResolved && <ul className="flex flex-col gap-3">{resolved.map(renderThread)}</ul>}
        </>
      )}
    </section>
  );
}
