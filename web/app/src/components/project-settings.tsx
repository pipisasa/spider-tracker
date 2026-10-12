import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { useArchiveProject, useUpdateProject } from "@/lib/work";
import type { ProjectDto } from "@repo/core/contracts";
import { updateProjectInput } from "@repo/core/schemas";
import { useState, type FormEvent } from "react";

/** Edit name and description, or archive. Owners and admins only (the API enforces it). */
export function ProjectSettingsDialog({
  orgSlug,
  project,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  project: ProjectDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const update = useUpdateProject(orgSlug, project.key);
  const archive = useArchiveProject(orgSlug);

  // Re-seed from the project each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(project.name);
      setDescription(project.description ?? "");
      setError(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = updateProjectInput.safeParse({
      name,
      description: description.trim() === "" ? null : description,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    const unchanged = parsed.data.name === project.name && (parsed.data.description ?? null) === (project.description ?? null);
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    update.mutate(parsed.data, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Project settings</DialogTitle>
              <DialogDescription>
                {project.key} - the key cannot be changed.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-description">Description (Markdown)</Label>
              <Textarea
                id="project-description"
                rows={6}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 p-3">
              <p className="text-sm text-muted-foreground">
                {project.archivedAt ? "This project is archived." : "Archive this project to retire it."}
              </p>
              {project.archivedAt ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate({ key: project.key, archive: false }, { onSuccess: () => onOpenChange(false) })}
                >
                  Restore
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmArchive(true)}
                >
                  Archive
                </Button>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={update.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its tasks stay readable, but no new tasks can be created. The
              project is hidden from the sidebar and can be restored from
              Settings, Projects.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() =>
                archive.mutate(
                  { key: project.key, archive: true },
                  { onSuccess: () => onOpenChange(false) },
                )
              }
            >
              Archive project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
