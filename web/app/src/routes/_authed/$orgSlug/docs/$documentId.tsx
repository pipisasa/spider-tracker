import {
  DocumentComments,
  SelectionCommentButton,
  threadsOf,
  useQuoteHighlights,
} from "@/components/document-comments";
import { DocumentContent } from "@/components/document-content";
import {
  DocumentIcon,
  FORMAT_LABELS,
  formatDateTime,
  MoveDocumentDialog,
} from "@/components/documents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WikiLinkHost } from "@/components/editor/wiki-link";
import { ApiError } from "@/lib/api";
import { nameOf } from "@/lib/assignees";
import { useWikiLinks } from "@/lib/use-wiki-links";
import {
  documentBacklinksQuery,
  documentCommentsQuery,
  documentDiffQuery,
  documentQuery,
  documentVersionQuery,
  documentVersionsQuery,
  actorsQuery,
  projectsQuery,
  useDeleteDocument,
  useUpdateDocument,
} from "@/lib/work";
import type {
  DiffHunkDto,
  DiffLineDto,
  DocumentDto,
  DocumentFormat,
  RelinkedDocumentsDto,
} from "@repo/core/contracts";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CodeIcon,
  LinkIcon,
  EyeIcon,
  MessageSquareIcon,
  FolderInputIcon,
  GitCompareIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

/** `compare` shows what changed from that version to `version` (or the current one), ST-117. */
type Search = { edit?: boolean; version?: number; compare?: number };

const positiveInt = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

// Tiptap is only loaded once someone edits a Markdown document.
const RichEditor = lazy(() => import("@/components/editor/rich-editor"));

export const Route = createFileRoute("/_authed/$orgSlug/docs/$documentId")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const version = positiveInt(search.version);
    const compare = positiveInt(search.compare);
    return {
      ...(search.edit === true || search.edit === "true" ? { edit: true } : {}),
      ...(version ? { version } : {}),
      ...(compare ? { compare } : {}),
    };
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      documentQuery(params.orgSlug, params.documentId),
    ),
  component: DocumentPage,
});

function DocumentPage() {
  const { orgSlug, documentId } = Route.useParams();
  const { edit = false, version, compare } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { data: doc } = useSuspenseQuery(documentQuery(orgSlug, documentId));
  const { data: projects = [] } = useQuery(projectsQuery(orgSlug));
  const [moving, setMoving] = useState(false);
  // The side panel: version history or comments (ST-118).
  const [panel, setPanel] = useState<"history" | "comments" | null>(
    version !== undefined || compare !== undefined ? "history" : "comments",
  );
  const showHistory = panel === "history";
  const togglePanel = (which: "history" | "comments") =>
    setPanel((p) => (p === which ? null : which));
  // A fragment picked for a new comment, and the thread in focus.
  const [quote, setQuote] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const activate = useCallback((id: string | null) => {
    setActiveThread(id);
    if (id) setPanel("comments");
  }, []);
  // State, not a ref: the content isn't rendered while an old version or a diff shows.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const { data: comments = [] } = useQuery(
    documentCommentsQuery(orgSlug, documentId),
  );
  const threads = useMemo(() => threadsOf(comments), [comments]);
  const openThreads = threads.filter((t) => !t.root.resolvedAt).length;
  useQuoteHighlights(contentEl, threads, activeThread, activate);
  // Bumped to restart the editor from the latest saved version.
  const [session, setSession] = useState(0);
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const remove = useDeleteDocument(orgSlug);
  const canWrite = membership.actor.role !== "guest";
  const project = projects.find((p) => p.key === doc.projectKey);
  const wikiLinks = useWikiLinks({ orgSlug, from: doc, canWrite });

  const viewingOld = version !== undefined && version !== doc.version;
  const setSearch = (search: Search) => navigate({ search, replace: true });
  /** Compares two versions, older first; the current one stays out of the URL. */
  const showDiff = (a: number, b: number) => {
    const [from, to] = a < b ? [a, b] : [b, a];
    setSearch({
      compare: from,
      ...(to === doc.version ? {} : { version: to }),
    });
  };

  async function reload() {
    await qc.refetchQueries({
      queryKey: documentQuery(orgSlug, documentId).queryKey,
      exact: true,
    });
    setSession((n) => n + 1);
  }

  function deleteDocument() {
    if (!window.confirm(`Delete "${doc.title}"?`)) return;
    remove.mutate(doc.id, {
      onSuccess: async () => {
        toast.success(`Deleted ${doc.title}`);
        if (doc.taskKey)
          await navigate({
            to: "/$orgSlug/tasks/$taskKey",
            params: { orgSlug, taskKey: doc.taskKey },
          });
        else if (doc.projectKey) {
          await navigate({
            to: "/$orgSlug/projects/$projectKey",
            params: { orgSlug, projectKey: doc.projectKey },
            search: { view: "docs" },
          });
        } else await navigate({ to: "/$orgSlug/docs", params: { orgSlug } });
      },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <main className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-8 md:py-6">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <Link
            to="/$orgSlug/docs"
            params={{ orgSlug }}
            className="hover:text-foreground"
          >
            Documents
          </Link>
          <ChevronRightIcon className="size-4" />
          {doc.projectKey && (
            <>
              <Link
                to="/$orgSlug/projects/$projectKey"
                params={{ orgSlug, projectKey: doc.projectKey }}
                search={{ view: "docs" }}
                className="hover:text-foreground"
              >
                {project?.name ?? doc.projectKey}
              </Link>
              <ChevronRightIcon className="size-4" />
            </>
          )}
          {doc.taskKey && (
            <>
              <Link
                to="/$orgSlug/tasks/$taskKey"
                params={{ orgSlug, taskKey: doc.taskKey }}
                className="hover:text-foreground"
              >
                {doc.taskKey}
              </Link>
              <ChevronRightIcon className="size-4" />
            </>
          )}
          <span className="truncate">{doc.title}</span>
        </nav>

        {edit && canWrite ? (
          <DocumentEditor
            key={`${doc.id}-${session}`}
            orgSlug={orgSlug}
            doc={doc}
            onDone={() => setSearch({})}
            onReload={reload}
            wikiLinks={wikiLinks}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <DocumentIcon format={doc.format} />
              <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold">
                {doc.title}
              </h1>
              <Button
                variant={panel === "comments" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => togglePanel("comments")}
              >
                <MessageSquareIcon />
                Comments
                {openThreads > 0 && (
                  <span className="text-muted-foreground">{openThreads}</span>
                )}
              </Button>
              <Button
                variant={showHistory ? "secondary" : "ghost"}
                size="sm"
                onClick={() => togglePanel("history")}
              >
                <HistoryIcon />
                History
              </Button>
              {canWrite && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSearch({ edit: true })}
                  >
                    <PencilIcon />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMoving(true)}
                  >
                    <FolderInputIcon />
                    Move to…
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    aria-label="Delete document"
                    onClick={deleteDocument}
                    disabled={remove.isPending}
                  >
                    <Trash2Icon />
                  </Button>
                </>
              )}
            </div>
            {compare !== undefined ? (
              <VersionDiff
                orgSlug={orgSlug}
                doc={doc}
                from={compare}
                to={version ?? doc.version}
                onChange={showDiff}
                onClose={() => setSearch(viewingOld ? { version } : {})}
              />
            ) : viewingOld ? (
              <OldVersion
                orgSlug={orgSlug}
                doc={doc}
                version={version}
                canWrite={canWrite}
                onCompare={() => showDiff(version, doc.version)}
                onClose={() => setSearch({})}
              />
            ) : (
              <>
                {/* Markdown is rendered in the page, so its text can be selected and quotes highlighted; HTML runs in a sandboxed frame. */}
                <div ref={setContentEl}>
                  <DocumentContent
                    format={doc.format}
                    content={doc.content}
                    wikiLinks={wikiLinks}
                  />
                </div>
                {canWrite && doc.format === "md" && (
                  <SelectionCommentButton
                    container={contentEl}
                    onComment={(text) => {
                      setQuote(text);
                      setActiveThread(null);
                      setPanel("comments");
                    }}
                  />
                )}
                <Backlinks orgSlug={orgSlug} doc={doc} />
              </>
            )}
          </>
        )}
      </main>

      {canWrite && (
        <MoveDocumentDialog
          key={`${doc.projectKey}-${doc.taskKey}`}
          orgSlug={orgSlug}
          doc={doc}
          open={moving}
          onOpenChange={setMoving}
        />
      )}

      {panel === "comments" && !edit && (
        <aside className="flex w-full shrink-0 flex-col gap-3 border-t p-4 md:w-80 md:border-t-0 md:border-l">
          <DocumentComments
            orgSlug={orgSlug}
            documentId={doc.id}
            canWrite={canWrite}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            active={activeThread}
            onActivate={activate}
          />
        </aside>
      )}

      {showHistory && !edit && (
        <aside className="flex w-full shrink-0 flex-col gap-3 border-t p-4 md:w-72 md:border-t-0 md:border-l">
          <VersionHistory
            orgSlug={orgSlug}
            doc={doc}
            selected={viewingOld ? version : doc.version}
            onSelect={(v) => setSearch(v === doc.version ? {} : { version: v })}
            onCompare={(v) => showDiff(v, viewingOld ? version : doc.version)}
          />
        </aside>
      )}
    </div>
  );
}

/** What a rename did to the links leading here (ST-101), for the save toast. */
function relinkedSummary(relinked: RelinkedDocumentsDto | undefined) {
  if (!relinked) return undefined;
  const parts: string[] = [];
  const { rewritten, skipped } = relinked;
  if (rewritten.length)
    parts.push(
      `Updated links in ${rewritten.length} ${rewritten.length === 1 ? "document" : "documents"}.`,
    );
  if (skipped.length)
    parts.push(
      `Not in ${skipped.map((d) => d.title).join(", ")} (${skipped.some((d) => d.reason === "rules") ? "project rules: only owners and admins can change them" : "too large"}).`,
    );
  return parts.join(" ") || undefined;
}

/** Documents linking here with `[[this title]]` (ST-100). */
function Backlinks({ orgSlug, doc }: { orgSlug: string; doc: DocumentDto }) {
  const { data: backlinks = [] } = useQuery(
    documentBacklinksQuery(orgSlug, doc.id),
  );
  if (!backlinks.length) return null;
  return (
    <section
      aria-labelledby="backlinks-heading"
      className="mt-6 flex flex-col gap-2 border-t pt-4"
    >
      <h2
        id="backlinks-heading"
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
      >
        <LinkIcon className="size-4" />
        Linked from {backlinks.length}{" "}
        {backlinks.length === 1 ? "document" : "documents"}
      </h2>
      <ul className="flex flex-col gap-0.5">
        {backlinks.map((b) => (
          <li key={b.id}>
            <Link
              to="/$orgSlug/docs/$documentId"
              params={{ orgSlug, documentId: b.id }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <DocumentIcon format={b.format} />
              <span className="min-w-0 flex-1 truncate">{b.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {b.taskKey ?? b.projectKey ?? "Organization"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VersionHistory({
  orgSlug,
  doc,
  selected,
  onSelect,
  onCompare,
}: {
  orgSlug: string;
  doc: DocumentDto;
  selected: number;
  onSelect: (version: number) => void;
  /** Compares this version with the selected one. */
  onCompare: (version: number) => void;
}) {
  const { data: versions = [] } = useQuery(
    documentVersionsQuery(orgSlug, doc.id),
  );
  const { data: members = [] } = useQuery(actorsQuery(orgSlug));
  return (
    <>
      <h2 className="text-sm font-medium text-muted-foreground">
        Version history
      </h2>
      <ul className="flex flex-col gap-1">
        {versions.map((v) => {
          const author = members.find((m) => m.id === v.authorId);
          return (
            <li key={v.version} className="group flex items-start gap-1">
              <button
                type="button"
                onClick={() => onSelect(v.version)}
                aria-current={v.version === selected}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
              >
                <span className="font-medium">
                  Version {v.version}
                  {v.version === doc.version && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · current
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {nameOf(author, "Unknown")} · {formatDateTime(v.createdAt)}
                </span>
              </button>
              {v.version !== selected && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="mt-1 opacity-60 group-hover:opacity-100"
                  aria-label={`Compare version ${v.version} with version ${selected}`}
                  title={`Compare with version ${selected}`}
                  onClick={() => onCompare(v.version)}
                >
                  <GitCompareIcon />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** An older version, read-only, with Restore (saved as a new version). */
function OldVersion({
  orgSlug,
  doc,
  version,
  canWrite,
  onCompare,
  onClose,
}: {
  orgSlug: string;
  doc: DocumentDto;
  version: number;
  canWrite: boolean;
  onCompare: () => void;
  onClose: () => void;
}) {
  const { data: old, error } = useQuery(
    documentVersionQuery(orgSlug, doc.id, version),
  );
  const update = useUpdateDocument(orgSlug, doc.id);

  function restore() {
    if (!old) return;
    update.mutate(
      {
        baseVersion: doc.version,
        title: old.title,
        format: old.format,
        content: old.content,
      },
      {
        onSuccess: (saved) => {
          toast.success(
            saved.version === doc.version
              ? `Version ${version} matches the current one`
              : `Restored version ${version} as version ${saved.version}`,
          );
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span className="flex-1">
          Viewing version {version} of {doc.version}
          {old && old.title !== doc.title && <> · titled “{old.title}”</>}
        </span>
        <Button size="sm" variant="outline" onClick={onCompare}>
          <GitCompareIcon />
          Compare with current
        </Button>
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            onClick={restore}
            disabled={!old || update.isPending}
          >
            <RotateCcwIcon />
            Restore
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Back to current
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {old && <DocumentContent format={old.format} content={old.content} />}
    </>
  );
}

/** What changed between two versions, line by line (ST-117), with pickers for both ends. */
function VersionDiff({
  orgSlug,
  doc,
  from,
  to,
  onChange,
  onClose,
}: {
  orgSlug: string;
  doc: DocumentDto;
  from: number;
  to: number;
  onChange: (from: number, to: number) => void;
  onClose: () => void;
}) {
  const { data: versions = [] } = useQuery(
    documentVersionsQuery(orgSlug, doc.id),
  );
  const { data: diff, error } = useQuery(
    documentDiffQuery(orgSlug, doc.id, from, to),
  );
  const picker = (value: number, label: string, set: (v: number) => void) => (
    <Select value={String(value)} onValueChange={(v) => set(Number(v))}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {versions.map((v) => (
          <SelectItem key={v.version} value={String(v.version)}>
            Version {v.version}
            {v.version === doc.version ? " (current)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span>Comparing</span>
        {picker(from, "Older version", (v) => onChange(v, to))}
        <span aria-hidden>→</span>
        {picker(to, "Newer version", (v) => onChange(from, v))}
        {diff && (
          <span className="flex-1 text-muted-foreground">
            <span className="text-emerald-700 dark:text-emerald-400">
              +{diff.added}
            </span>{" "}
            <span className="text-red-700 dark:text-red-400">
              −{diff.removed}
            </span>
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {diff && diff.from.title !== diff.to.title && (
        <p className="text-sm text-muted-foreground">
          Title: “{diff.from.title}” → “{diff.to.title}”
        </p>
      )}
      {diff &&
        (diff.hunks.length ? (
          <div className="overflow-x-auto rounded-lg border font-mono text-xs">
            {diff.hunks.map((hunk, i) => (
              <DiffHunk key={i} hunk={hunk} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No changes in content between version {diff.from.version} and{" "}
            {diff.to.version}.
          </p>
        ))}
    </>
  );
}

const DIFF_LINE_STYLES: Record<DiffLineDto["kind"], string> = {
  context: "",
  added: "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
  removed: "bg-red-500/10 text-red-900 dark:text-red-200",
};

const DIFF_MARKS: Record<DiffLineDto["kind"], string> = {
  context: " ",
  added: "+",
  removed: "−",
};

function DiffHunk({ hunk }: { hunk: DiffHunkDto }) {
  return (
    <div className="border-b last:border-b-0">
      <div className="bg-muted/60 px-3 py-1 text-muted-foreground">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {hunk.lines.map((line, i) => (
        <div key={i} className={`flex ${DIFF_LINE_STYLES[line.kind]}`}>
          <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
            {line.oldLine ?? ""}
          </span>
          <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
            {line.newLine ?? ""}
          </span>
          <span className="w-4 shrink-0 select-none text-center" aria-hidden>
            {DIFF_MARKS[line.kind]}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3">
            <span className="sr-only">
              {line.kind === "context" ? "" : `${line.kind}: `}
            </span>
            {line.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Markdown documents get a rich editor with a Markdown source toggle; HTML documents
 * a source editor with a preview toggle. Saves name the version the edit started from.
 */
function DocumentEditor({
  orgSlug,
  doc,
  onDone,
  onReload,
  wikiLinks,
}: {
  orgSlug: string;
  doc: DocumentDto;
  onDone: () => void;
  onReload: () => Promise<void>;
  wikiLinks: WikiLinkHost;
}) {
  const [baseVersion] = useState(doc.version);
  const [title, setTitle] = useState(doc.title);
  const [format, setFormat] = useState<DocumentFormat>(doc.format);
  const [content, setContent] = useState(doc.content);
  const [preview, setPreview] = useState(false);
  const [mode, setMode] = useState<"rich" | "markdown">("rich");
  const update = useUpdateDocument(orgSlug, doc.id);
  const dirty =
    title !== doc.title || format !== doc.format || content !== doc.content;
  const newerSaved = doc.version > baseVersion;

  function reload() {
    if (
      dirty &&
      !window.confirm("Discard your changes and load the latest version?")
    )
      return;
    void onReload();
  }

  function save() {
    if (!title.trim()) {
      toast.error("The title can't be empty");
      return;
    }
    update.mutate(
      { baseVersion, title, format, content },
      {
        onSuccess: (saved) => {
          if (saved.version !== baseVersion)
            toast.success(`Saved version ${saved.version}`, {
              description: relinkedSummary(saved.relinked),
            });
          onDone();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            toast.error("Someone else changed this document", {
              description:
                "Your edits are still in the editor. Copy what you need, then reload the latest version.",
              action: { label: "Reload", onClick: reload },
              duration: 15_000,
            });
          } else toast.error(err.message);
        },
      },
    );
  }

  function cancel() {
    if (dirty && !window.confirm("Discard your changes?")) return;
    onDone();
  }

  return (
    <div
      className="flex flex-1 flex-col gap-3"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="Title"
          className="h-auto flex-1 text-xl font-semibold md:text-xl"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Select
          value={format}
          onValueChange={(v) => setFormat(v === "html" ? "html" : "md")}
        >
          <SelectTrigger className="w-32" aria-label="Format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="md">{FORMAT_LABELS.md}</SelectItem>
            <SelectItem value="html">{FORMAT_LABELS.html}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {newerSaved && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="flex-1">
            Version {doc.version} was saved while you were editing version{" "}
            {baseVersion}. Saving now will fail.
          </span>
          <Button size="sm" variant="outline" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      <div className="flex items-center gap-1">
        {format === "md" ? (
          <>
            <Button
              variant={mode === "rich" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setMode("rich")}
            >
              <SparklesIcon />
              Rich
            </Button>
            <Button
              variant={mode === "markdown" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setMode("markdown")}
            >
              <CodeIcon />
              Markdown
            </Button>
          </>
        ) : (
          <>
            <Button
              variant={preview ? "ghost" : "secondary"}
              size="sm"
              onClick={() => setPreview(false)}
            >
              <PencilIcon />
              Write
            </Button>
            <Button
              variant={preview ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPreview(true)}
            >
              <EyeIcon />
              Preview
            </Button>
          </>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          Editing version {baseVersion}
        </span>
      </div>
      {format === "md" && mode === "rich" ? (
        <Suspense
          fallback={
            <p className="min-h-[60vh] text-sm text-muted-foreground">
              Loading editor…
            </p>
          }
        >
          <RichEditor
            value={content}
            onChange={setContent}
            wikiLinks={wikiLinks}
          />
        </Suspense>
      ) : format === "html" && preview ? (
        <DocumentContent format={format} content={content} />
      ) : (
        <Textarea
          aria-label="Content"
          placeholder={
            format === "html"
              ? "<h1>Title</h1>"
              : "# Title\n\nWrite in Markdown…"
          }
          className="min-h-[60vh] flex-1 resize-y font-mono text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      )}
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
