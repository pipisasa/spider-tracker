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
import { ApiError } from "@/lib/api";
import {
  documentQuery,
  documentVersionQuery,
  documentVersionsQuery,
  membersQuery,
  projectsQuery,
  useDeleteDocument,
  useUpdateDocument,
} from "@/lib/work";
import type { DocumentDto, DocumentFormat } from "@repo/core/contracts";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CodeIcon,
  EyeIcon,
  FolderInputIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";

type Search = { edit?: boolean; version?: number };

// Tiptap is only loaded once someone edits a Markdown document.
const RichEditor = lazy(() => import("@/components/editor/rich-editor"));

export const Route = createFileRoute("/_authed/$orgSlug/docs/$documentId")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const version = Number(search.version);
    return {
      ...(search.edit === true || search.edit === "true" ? { edit: true } : {}),
      ...(Number.isInteger(version) && version > 0 ? { version } : {}),
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
  const { edit = false, version } = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const { data: doc } = useSuspenseQuery(documentQuery(orgSlug, documentId));
  const { data: projects = [] } = useQuery(projectsQuery(orgSlug));
  const [moving, setMoving] = useState(false);
  const [showHistory, setShowHistory] = useState(version !== undefined);
  // Bumped to restart the editor from the latest saved version.
  const [session, setSession] = useState(0);
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();
  const remove = useDeleteDocument(orgSlug);
  const canWrite = membership.actor.role !== "guest";
  const project = projects.find((p) => p.key === doc.projectKey);

  const viewingOld = version !== undefined && version !== doc.version;
  const setSearch = (search: Search) => navigate({ search, replace: true });

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
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
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
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <DocumentIcon format={doc.format} />
              <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold">
                {doc.title}
              </h1>
              <Button
                variant={showHistory ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setShowHistory((v) => !v)}
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
            {viewingOld ? (
              <OldVersion
                orgSlug={orgSlug}
                doc={doc}
                version={version}
                canWrite={canWrite}
                onClose={() => setSearch({})}
              />
            ) : (
              <DocumentContent format={doc.format} content={doc.content} />
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

      {showHistory && !edit && (
        <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t p-4 md:w-72 md:border-t-0 md:border-l">
          <VersionHistory
            orgSlug={orgSlug}
            doc={doc}
            selected={viewingOld ? version : doc.version}
            onSelect={(v) => setSearch(v === doc.version ? {} : { version: v })}
          />
        </aside>
      )}
    </div>
  );
}

function VersionHistory({
  orgSlug,
  doc,
  selected,
  onSelect,
}: {
  orgSlug: string;
  doc: DocumentDto;
  selected: number;
  onSelect: (version: number) => void;
}) {
  const { data: versions = [] } = useQuery(
    documentVersionsQuery(orgSlug, doc.id),
  );
  const { data: members = [] } = useQuery(membersQuery(orgSlug));
  return (
    <>
      <h2 className="text-sm font-medium text-muted-foreground">
        Version history
      </h2>
      <ul className="flex flex-col gap-1">
        {versions.map((v) => {
          const author = members.find((m) => m.id === v.authorId);
          return (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => onSelect(v.version)}
                aria-current={v.version === selected}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
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
                  {author?.name ?? "Unknown"} · {formatDateTime(v.createdAt)}
                </span>
              </button>
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
  onClose,
}: {
  orgSlug: string;
  doc: DocumentDto;
  version: number;
  canWrite: boolean;
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

/**
 * Markdown documents get a rich editor with a Markdown source toggle; HTML documents
 * a source editor with a preview toggle. Saves name the version the edit started from.
 */
function DocumentEditor({
  orgSlug,
  doc,
  onDone,
  onReload,
}: {
  orgSlug: string;
  doc: DocumentDto;
  onDone: () => void;
  onReload: () => Promise<void>;
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
            toast.success(`Saved version ${saved.version}`);
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
          <RichEditor value={content} onChange={setContent} />
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
