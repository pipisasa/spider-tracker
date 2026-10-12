import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  archivedProjectsQuery,
  documentsQuery,
  actorsQuery,
  projectsQuery,
  useCreateDocument,
  useMoveDocument,
  type DocumentScope,
} from "@/lib/work";
import { nameOf } from "@/lib/assignees";
import type { DocumentFormat, DocumentSummaryDto } from "@repo/core/contracts";
import { createDocumentInput } from "@repo/core/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileCodeIcon, FileTextIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

// Documents (ST-21): lists, the "new document" dialog and the task page section.

export const FORMAT_LABELS: Record<DocumentFormat, string> = {
  md: "Markdown",
  html: "HTML",
};

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
export const formatDateTime = (iso: string) =>
  dateTimeFormat.format(new Date(iso));

export function DocumentIcon({ format }: { format: DocumentFormat }) {
  const Icon = format === "html" ? FileCodeIcon : FileTextIcon;
  return (
    <Icon
      className="size-4 shrink-0 text-muted-foreground"
      aria-label={FORMAT_LABELS[format]}
    />
  );
}

/** Documents as rows; `showScope` adds the project or task each belongs to. */
export function DocumentList({
  orgSlug,
  documents,
  showScope = false,
  empty = "No documents yet.",
}: {
  orgSlug: string;
  documents: DocumentSummaryDto[];
  showScope?: boolean;
  empty?: string;
}) {
  const { data: members = [] } = useQuery(actorsQuery(orgSlug));
  if (documents.length === 0)
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {documents.map((d) => {
        const author = members.find((m) => m.id === d.authorId);
        return (
          <li key={d.id}>
            <Link
              to="/$orgSlug/docs/$documentId"
              params={{ orgSlug, documentId: d.id }}
              className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
            >
              <DocumentIcon format={d.format} />
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              {showScope && (
                <span className="flex w-28 shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {d.projectKey && (
                    <Badge variant="secondary">{d.projectKey}</Badge>
                  )}
                  {d.taskKey ?? (d.projectKey ? "" : "Organization")}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                v{d.version}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {author ? `${nameOf(author, "")} · ` : ""}
                {formatDateTime(d.updatedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Creates a document in `scope` (organization-wide when empty) and opens it for editing. */
export function NewDocumentDialog({
  orgSlug,
  scope,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  scope: DocumentScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<DocumentFormat>("md");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateDocument(orgSlug);
  const navigate = useNavigate();
  const where = scope.task ?? scope.project ?? "the organization";

  function reset() {
    setTitle("");
    setFormat("md");
    setError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createDocumentInput.safeParse({ title, format, ...scope });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: async (document) => {
        onOpenChange(false);
        reset();
        await navigate({
          to: "/$orgSlug/docs/$documentId",
          params: { orgSlug, documentId: document.id },
          search: { edit: true },
        });
      },
      onError: (err) => setError(err.message),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              A spec, plan or report in {where}. Agents can read and edit it
              too.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_9rem] gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="document-title">Title</Label>
              <Input
                id="document-title"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="document-format">Format</Label>
              <Select
                value={format}
                onValueChange={(v) => setFormat(v === "html" ? "html" : "md")}
              >
                <SelectTrigger id="document-format" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="md">{FORMAT_LABELS.md}</SelectItem>
                  <SelectItem value="html">{FORMAT_LABELS.html}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The documents section on a task page. */
export function TaskDocuments({
  orgSlug,
  taskKey,
  canWrite,
}: {
  orgSlug: string;
  taskKey: string;
  canWrite: boolean;
}) {
  const { data: documents = [] } = useQuery(
    documentsQuery(orgSlug, { task: taskKey }),
  );
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center justify-between text-sm font-medium text-muted-foreground">
        Documents
        {canWrite && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <PlusIcon />
            New document
          </Button>
        )}
      </h2>
      <DocumentList
        orgSlug={orgSlug}
        documents={documents}
        empty="No documents on this task."
      />
      <NewDocumentDialog
        orgSlug={orgSlug}
        scope={{ task: taskKey }}
        open={open}
        onOpenChange={setOpen}
      />
    </section>
  );
}

const ORG_VALUE = "__org";

/** Picks a project (or the whole organization) to move a document to. */
export function MoveDocumentDialog({
  orgSlug,
  doc,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  doc: DocumentSummaryDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: projects = [], isSuccess } = useQuery(projectsQuery(orgSlug));
  // Only active projects are listed; a document in an archived one still shows where it is.
  const archivedKey =
    isSuccess && doc.projectKey && !projects.some((p) => p.key === doc.projectKey)
      ? doc.projectKey
      : null;
  const { data: archived = [] } = useQuery({
    ...archivedProjectsQuery(orgSlug),
    enabled: open && archivedKey !== null,
  });
  const archivedProject = archived.find((p) => p.key === archivedKey);
  const [target, setTarget] = useState(doc.projectKey ?? ORG_VALUE);
  const move = useMoveDocument(orgSlug, doc.id);
  const unchanged = target === (doc.projectKey ?? ORG_VALUE) && !doc.taskKey;

  function submit(event: FormEvent) {
    event.preventDefault();
    move.mutate(
      { project: target === ORG_VALUE ? null : target },
      {
        onSuccess: (moved) => {
          onOpenChange(false);
          toast.success(
            `Moved ${moved.title} to ${moved.projectKey ?? "the organization"}`,
          );
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Move document</DialogTitle>
            <DialogDescription>
              Keeps the document&apos;s versions and history.
              {doc.taskKey && ` It will no longer be attached to ${doc.taskKey}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="move-document-target">Move to</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="move-document-target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ORG_VALUE}>Organization-wide</SelectItem>
                {archivedKey && (
                  <SelectItem value={archivedKey} disabled>
                    {archivedProject
                      ? `${archivedProject.name} (${archivedKey})`
                      : archivedKey}{" "}
                    (archived)
                  </SelectItem>
                )}
                {projects.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.name} ({p.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={move.isPending || unchanged}>
              {move.isPending ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
