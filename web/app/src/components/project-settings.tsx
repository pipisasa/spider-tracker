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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  documentsQuery,
  reposQuery,
  useArchiveProject,
  useUpdateProject,
} from "@/lib/work";
import type {
  GitAutomationEvent,
  GitAutomationSettings,
  ProjectDto,
  StatusCategory,
} from "@repo/core/contracts";
import { DEFAULT_GIT_AUTOMATION } from "@repo/core/git-automation-rules";
import { statusCategorySchema, updateProjectInput } from "@repo/core/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

const NO_RULES = "none";
const NO_CHANGE = "none";

const CATEGORY_LABELS: Record<StatusCategory, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

// Status automation from pull requests (ST-85): each event and the category its tasks move to.
const AUTOMATION_EVENTS: { event: GitAutomationEvent; label: string }[] = [
  { event: "draft", label: "Draft opened or converted" },
  { event: "opened", label: "Opened or ready for review" },
  { event: "merged", label: "Merged" },
  { event: "closed", label: "Closed without merging" },
];

const sameAutomation = (a: GitAutomationSettings, b: GitAutomationSettings) =>
  a.enabled === b.enabled &&
  AUTOMATION_EVENTS.every(({ event }) => a[event] === b[event]);

/** Edit name, description, rules for agents and status automation, or archive. Owners and admins only (the API enforces it). */
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
  const [rules, setRules] = useState(project.rulesDocumentId ?? NO_RULES);
  const [automation, setAutomation] = useState<GitAutomationSettings>(
    project.gitAutomation,
  );
  // Only the project's own documents (not its tasks') can be its rules.
  const { data: documents = [] } = useQuery({
    ...documentsQuery(orgSlug, { project: project.key }),
    enabled: open,
  });
  const candidates = documents.filter((d) => d.taskKey === null);
  // Its repos (ST-84): branches, commits and PRs there link to its tasks. Attached in Settings → Repos.
  const { data: repos = [] } = useQuery({
    ...reposQuery(orgSlug),
    enabled: open,
  });
  const attached = repos.filter((r) => r.projects.includes(project.key));
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
      setRules(project.rulesDocumentId ?? NO_RULES);
      setAutomation(project.gitAutomation);
      setError(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const automationChanged = !sameAutomation(
      automation,
      project.gitAutomation,
    );
    const parsed = updateProjectInput.safeParse({
      name,
      description: description.trim() === "" ? null : description,
      rulesDocumentId: rules === NO_RULES ? null : rules,
      ...(automationChanged ? { gitAutomation: automation } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    const unchanged =
      parsed.data.name === project.name &&
      (parsed.data.description ?? null) === (project.description ?? null) &&
      (parsed.data.rulesDocumentId ?? null) === project.rulesDocumentId &&
      !automationChanged;
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    update.mutate(parsed.data, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
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
              <Label htmlFor="project-description">
                Description (Markdown)
              </Label>
              <Textarea
                id="project-description"
                rows={6}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-rules">Rules for agents</Label>
              <Select value={rules} onValueChange={setRules}>
                <SelectTrigger id="project-rules" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_RULES}>None</SelectItem>
                  {candidates.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                One of this project&apos;s documents. Agents working in{" "}
                {project.key} get it automatically and are notified when it
                changes; only owners, admins and their agents can edit it.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Repos</Label>
              <p className="text-sm">
                {attached.length ? (
                  attached.map((r) => r.fullName).join(", ")
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                Branches, commits and pull requests in these repos that name a{" "}
                {project.key} task link to it. Attach or detach repos in{" "}
                <Link
                  to="/$orgSlug/settings/repos"
                  params={{ orgSlug }}
                  className="underline underline-offset-2"
                  onClick={() => onOpenChange(false)}
                >
                  Settings → Repos
                </Link>
                .
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="project-automation">Status automation</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sameAutomation(automation, DEFAULT_GIT_AUTOMATION)}
                  onClick={() => setAutomation(DEFAULT_GIT_AUTOMATION)}
                >
                  Defaults
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="project-automation"
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={automation.enabled}
                  onChange={(e) =>
                    setAutomation({ ...automation, enabled: e.target.checked })
                  }
                />
                Move tasks when their pull requests change
              </label>
              {automation.enabled && (
                <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
                  {AUTOMATION_EVENTS.map(({ event, label }) => (
                    <AutomationRow
                      key={event}
                      label={label}
                      value={automation[event]}
                      onChange={(value) =>
                        setAutomation({ ...automation, [event]: value })
                      }
                    />
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                As @github, to the first status of that kind in the task&apos;s
                workflow. Only for pull requests that name the task in their
                branch, title or a closing keyword (&quot;Fixes {project.key}
                -12&quot;); tasks only move forward, and Merged waits for the
                task&apos;s other open pull requests.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 p-3">
              <p className="text-sm text-muted-foreground">
                {project.archivedAt
                  ? "This project is archived."
                  : "Archive this project to retire it."}
              </p>
              {project.archivedAt ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={archive.isPending}
                  onClick={() =>
                    archive.mutate(
                      { key: project.key, archive: false },
                      { onSuccess: () => onOpenChange(false) },
                    )
                  }
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

function AutomationRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: StatusCategory | null;
  onChange: (value: StatusCategory | null) => void;
}) {
  return (
    <>
      <span className="text-sm">{label}</span>
      <Select
        value={value ?? NO_CHANGE}
        onValueChange={(next) => {
          const parsed = statusCategorySchema.safeParse(next);
          onChange(parsed.success ? parsed.data : null);
        }}
      >
        <SelectTrigger className="w-40" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CHANGE}>No change</SelectItem>
          {statusCategorySchema.options.map((category) => (
            <SelectItem key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
