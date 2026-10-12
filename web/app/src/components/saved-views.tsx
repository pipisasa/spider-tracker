import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeFilters, sameFilters, type TaskFilters } from "@/lib/task-filters";
import { useCreateView, useDeleteView, useUpdateView, viewsQuery } from "@/lib/work";
import type { ActorRole, SavedViewDto } from "@repo/core/contracts";
import { createSavedViewInput, updateSavedViewInput } from "@repo/core/schemas";
import { useQuery } from "@tanstack/react-query";
import { BookmarkIcon, CheckIcon, ChevronDownIcon, PencilIcon, Trash2Icon, UsersIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

// Saved views of the project page (ST-15): apply one (sets the URL), save the current filters,
// rename or delete your own (organization owners and admins manage shared ones too).

type Layout = "board" | "list";

export function SavedViewsMenu({
  orgSlug,
  projectKey,
  filters,
  layout,
  actorId,
  role,
  onApply,
}: {
  orgSlug: string;
  projectKey: string;
  filters: TaskFilters;
  layout: Layout;
  actorId: string;
  role: ActorRole;
  onApply: (view: SavedViewDto) => void;
}) {
  const { data: views = [] } = useQuery(viewsQuery(orgSlug, projectKey));
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const canSave = role !== "guest";
  const mine = views.filter((v) => v.ownerActorId === actorId);
  const shared = views.filter((v) => v.ownerActorId !== actorId);
  const manageable = views.filter((v) => canManage(v, actorId, role));
  const isCurrent = (v: SavedViewDto) => v.view === layout && sameFilters(v.filters, filters);

  const item = (v: SavedViewDto) => (
    <DropdownMenuCheckboxItem key={v.id} checked={isCurrent(v)} onSelect={() => onApply(v)}>
      <span className="truncate">{v.name}</span>
      <span className="ml-auto pl-3 text-xs text-muted-foreground">{v.view}</span>
    </DropdownMenuCheckboxItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Saved views">
            <BookmarkIcon />
            Views
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {views.length === 0 && <DropdownMenuLabel className="font-normal text-muted-foreground">No saved views yet</DropdownMenuLabel>}
          {mine.length > 0 && (
            <>
              <DropdownMenuLabel>My views</DropdownMenuLabel>
              {mine.map(item)}
            </>
          )}
          {shared.length > 0 && (
            <>
              {mine.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>Shared views</DropdownMenuLabel>
              {shared.map(item)}
            </>
          )}
          {(canSave || manageable.length > 0) && <DropdownMenuSeparator />}
          {canSave && <DropdownMenuItem onSelect={() => setSaveOpen(true)}>Save view…</DropdownMenuItem>}
          {manageable.length > 0 && <DropdownMenuItem onSelect={() => setManageOpen(true)}>Manage views…</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      {canSave && <SaveViewDialog orgSlug={orgSlug} projectKey={projectKey} filters={filters} layout={layout} open={saveOpen} onOpenChange={setSaveOpen} />}
      <ManageViewsDialog
        orgSlug={orgSlug}
        projectKey={projectKey}
        views={manageable}
        actorId={actorId}
        open={manageOpen}
        onOpenChange={setManageOpen}
      />
    </>
  );
}

/** Owners of a view, and organization owners and admins, may change it. */
const canManage = (view: SavedViewDto, actorId: string, role: ActorRole) =>
  role !== "guest" && (view.ownerActorId === actorId || role === "owner" || role === "admin");

function SaveViewDialog({
  orgSlug,
  projectKey,
  filters,
  layout,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  projectKey: string;
  filters: TaskFilters;
  layout: Layout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateView(orgSlug, projectKey);

  function submit(event: FormEvent) {
    event.preventDefault();
    // tagMatch is stored explicitly (see viewFiltersSchema).
    const stored = { ...normalizeFilters(filters), tagMatch: filters.tagMatch ?? "all" };
    const parsed = createSavedViewInput.safeParse({ name, filters: stored, shared, view: layout });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (view) => {
        toast.success(`Saved view “${view.name}”`);
        setName("");
        setShared(false);
        setError(null);
        onOpenChange(false);
      },
      onError: (err) => setError(err.message),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>Saves the current filters and the {layout} layout for this project.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="view-name">Name</Label>
            <Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Share with everyone who can see this project
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save view"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManageViewsDialog({
  orgSlug,
  projectKey,
  views,
  actorId,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  projectKey: string;
  views: SavedViewDto[];
  actorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage views</DialogTitle>
          <DialogDescription>Rename, share or delete saved views of this project.</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {views.map((view) => (
            <ManageRow key={view.id} orgSlug={orgSlug} projectKey={projectKey} view={view} own={view.ownerActorId === actorId} />
          ))}
          {views.length === 0 && <li className="text-sm text-muted-foreground">No views to manage.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function ManageRow({ orgSlug, projectKey, view, own }: { orgSlug: string; projectKey: string; view: SavedViewDto; own: boolean }) {
  const update = useUpdateView(orgSlug, projectKey);
  const remove = useDeleteView(orgSlug, projectKey);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(view.name);
  const [confirming, setConfirming] = useState(false);

  function rename(event: FormEvent) {
    event.preventDefault();
    const parsed = updateSavedViewInput.safeParse({ name });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid name");
      return;
    }
    update.mutate({ id: view.id, ...parsed.data }, { onSuccess: () => setRenaming(false), onError: (err) => toast.error(err.message) });
  }

  return (
    <li className="flex items-center gap-2">
      {renaming ? (
        <form onSubmit={rename} className="flex flex-1 items-center gap-1">
          <Input aria-label="View name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
          <Button type="submit" size="icon" variant="ghost" aria-label="Save name" disabled={update.isPending}>
            <CheckIcon />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Cancel rename"
            onClick={() => {
              setName(view.name);
              setRenaming(false);
            }}
          >
            <XIcon />
          </Button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-sm">
            {view.name}
            {!own && <span className="ml-2 text-xs text-muted-foreground">someone else’s</span>}
          </span>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={view.shared}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ id: view.id, shared: e.target.checked }, { onError: (err) => toast.error(err.message) })}
            />
            <UsersIcon className="size-3.5" aria-hidden />
            Shared
          </label>
          <Button size="icon" variant="ghost" aria-label={`Rename ${view.name}`} onClick={() => setRenaming(true)}>
            <PencilIcon />
          </Button>
          {confirming ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(view.id, { onError: (err) => toast.error(err.message) })}
              onBlur={() => setConfirming(false)}
              autoFocus
            >
              Delete?
            </Button>
          ) : (
            <Button size="icon" variant="ghost" aria-label={`Delete ${view.name}`} onClick={() => setConfirming(true)}>
              <Trash2Icon />
            </Button>
          )}
        </>
      )}
    </li>
  );
}
