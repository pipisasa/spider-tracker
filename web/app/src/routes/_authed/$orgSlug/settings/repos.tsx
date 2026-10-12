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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  projectsQuery,
  reposQuery,
  useAttachRepo,
  useCreateApp,
  useCreateRepo,
  useDeleteApp,
  useDeleteRepo,
  useUpdateApp,
  useUpdateRepo,
} from "@/lib/work";
import type { AppDto, AppVersioning, RepoDto } from "@repo/core/contracts";
import { createAppInput, createRepoInput, updateAppInput, updateRepoInput } from "@repo/core/schemas";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

// Settings → Repos (ST-92): the organization's git repos, the projects they're attached to and
// their apps. Everyone reads; owners and admins (and their agents, through the API) manage.

export const Route = createFileRoute("/_authed/$orgSlug/settings/repos")({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(reposQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(projectsQuery(params.orgSlug)),
    ]),
  component: ReposSettingsPage,
});

/** "a, b , c" → ["a", "b", "c"]. */
const splitList = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

function ReposSettingsPage() {
  const { orgSlug } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const { data: repos } = useSuspenseQuery(reposQuery(orgSlug));

  return (
    <>
      <header className="border-b px-4 py-3 md:px-6">
        <h1 className="font-semibold">Repos</h1>
      </header>
      <main className="flex max-w-3xl flex-col gap-6 px-4 py-4 md:px-6">
        <p className="text-sm text-muted-foreground">
          Git repos of the organization, the projects they belong to, and their apps: the parts that releases version
          and deploy.{canManage ? "" : " Owners and admins manage them."}
        </p>
        {canManage && <AddRepoForm orgSlug={orgSlug} />}
        {repos.length === 0 && <p className="text-sm text-muted-foreground">No repos yet.</p>}
        {repos.map((repo) => (
          <RepoCard key={repo.id} orgSlug={orgSlug} repo={repo} canManage={canManage} />
        ))}
      </main>
    </>
  );
}

function AddRepoForm({ orgSlug }: { orgSlug: string }) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRepo(orgSlug);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = { url, defaultBranch: branch.trim() || undefined };
    const parsed = createRepoInput.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    create.mutate(input, {
      onSuccess: () => {
        setUrl("");
        setBranch("");
      },
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border p-3">
      <h2 className="text-sm font-medium">Add a repo</h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Remote URL"
          placeholder="https://github.com/owner/name or owner/name"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="sm:flex-1"
          required
        />
        <Input
          aria-label="Default branch"
          placeholder="main"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="sm:w-32"
        />
        <Button type="submit" disabled={create.isPending}>
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

function RepoCard({ orgSlug, repo, canManage }: { orgSlug: string; repo: RepoDto; canManage: boolean }) {
  const { data: projects } = useSuspenseQuery(projectsQuery(orgSlug));
  const attach = useAttachRepo(orgSlug);
  const remove = useDeleteRepo(orgSlug);
  const removeApp = useDeleteApp(orgSlug);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // undefined: closed; null: a new app.
  const [appDialog, setAppDialog] = useState<AppDto | null | undefined>(undefined);
  const unattached = projects.filter((p) => !repo.projects.includes(p.key));

  return (
    <section className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`https://github.com/${repo.fullName}`}
          target="_blank"
          rel="noreferrer"
          className="truncate font-medium hover:underline"
        >
          {repo.fullName}
        </a>
        <Badge variant="outline" title="Default branch">
          {repo.defaultBranch}
        </Badge>
        {repo.githubInstallationId !== null && (
          <Badge variant="secondary" title="Connected through the GitHub App (Settings → GitHub)">
            GitHub App
          </Badge>
        )}
        {canManage && (
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Projects</span>
        {repo.projects.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
        {repo.projects.map((key) => (
          <Badge key={key} variant="secondary" className="gap-1">
            {key}
            {canManage && (
              <button
                type="button"
                aria-label={`Detach from ${key}`}
                className="rounded-sm hover:text-destructive"
                disabled={attach.isPending}
                onClick={() => attach.mutate({ repo, project: key, attach: false })}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </Badge>
        ))}
        {canManage && unattached.length > 0 && (
          <Select value="" onValueChange={(project) => attach.mutate({ repo, project, attach: true })}>
            <SelectTrigger size="sm" className="text-xs" aria-label="Attach to a project">
              <SelectValue placeholder="Attach to…" />
            </SelectTrigger>
            <SelectContent>
              {unattached.map((p) => (
                <SelectItem key={p.id} value={p.key}>
                  {p.key} · {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Apps</span>
          {canManage && (
            <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setAppDialog(null)}>
              Add app
            </Button>
          )}
        </div>
        {repo.apps.length === 0 && <p className="text-sm text-muted-foreground">No apps yet.</p>}
        {repo.apps.map((app) => (
          <div key={app.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <span className="font-medium">{app.name}</span>
            <code className="text-xs">{app.path}</code>
            {app.sharedPaths.length > 0 && (
              <span className="text-xs text-muted-foreground">+ {app.sharedPaths.join(", ")}</span>
            )}
            <Badge variant="outline">{app.versioning}</Badge>
            <span className="text-xs text-muted-foreground">
              {app.environments.length ? app.environments.join(" → ") : "no environments"}
            </span>
            {canManage && (
              <div className="ml-auto flex gap-1">
                <Button variant="ghost" size="sm" className="h-7" onClick={() => setAppDialog(app)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={removeApp.isPending}
                  onClick={() => removeApp.mutate({ repo, app: app.name })}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && <RepoDialog orgSlug={orgSlug} repo={repo} onClose={() => setEditing(false)} />}
      {appDialog !== undefined && (
        <AppDialog orgSlug={orgSlug} repo={repo} app={appDialog} onClose={() => setAppDialog(undefined)} />
      )}
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {repo.fullName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its apps and project links are removed too. The repository on GitHub isn&apos;t touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => remove.mutate(repo)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RepoDialog({ orgSlug, repo, onClose }: { orgSlug: string; repo: RepoDto; onClose: () => void }) {
  const [url, setUrl] = useState(repo.fullName);
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateRepo(orgSlug);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = {
      url: url.trim() === repo.fullName ? undefined : url,
      defaultBranch: branch.trim() === repo.defaultBranch ? undefined : branch,
    };
    if (input.url === undefined && input.defaultBranch === undefined) {
      onClose();
      return;
    }
    const parsed = updateRepoInput.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    update.mutate({ repo, input }, { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit {repo.fullName}</DialogTitle>
            <DialogDescription>Change the remote after a rename on GitHub, or the default branch.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="repo-url">Remote</Label>
            <Input id="repo-url" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="repo-branch">Default branch</Label>
            <Input id="repo-branch" value={branch} onChange={(e) => setBranch(e.target.value)} required />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Adds an app (`app` null) or edits one. */
function AppDialog({
  orgSlug,
  repo,
  app,
  onClose,
}: {
  orgSlug: string;
  repo: RepoDto;
  app: AppDto | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(app?.name ?? "");
  const [path, setPath] = useState(app?.path ?? "");
  const [shared, setShared] = useState(app?.sharedPaths.join(", ") ?? "");
  const [versioning, setVersioning] = useState<AppVersioning>(app?.versioning ?? "semver");
  const [environments, setEnvironments] = useState(app?.environments.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateApp(orgSlug);
  const update = useUpdateApp(orgSlug);

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = { name, path, sharedPaths: splitList(shared), versioning, environments: splitList(environments) };
    const parsed = (app ? updateAppInput : createAppInput).safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    if (app) update.mutate({ repo, app: app.name, input }, { onSuccess: onClose });
    else create.mutate({ repo, input }, { onSuccess: onClose });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{app ? `Edit ${app.name}` : "Add an app"}</DialogTitle>
            <DialogDescription>A deployable part of {repo.fullName}, e.g. web, api or cli.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-name">Name</Label>
            <Input id="app-name" placeholder="web" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-path">Folder in the repo</Label>
            <Input id="app-path" placeholder="web/app" value={path} onChange={(e) => setPath(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-shared">Shared packages it depends on</Label>
            <Input
              id="app-shared"
              placeholder="packages/core, packages/sdk"
              value={shared}
              onChange={(e) => setShared(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-versioning">Versioning</Label>
            <Select value={versioning} onValueChange={(v) => setVersioning(v === "date" ? "date" : "semver")}>
              <SelectTrigger id="app-versioning" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semver">semver (1.4.0)</SelectItem>
                <SelectItem value="date">date (2026.10.12)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-environments">Environments, in deploy order</Label>
            <Input
              id="app-environments"
              placeholder="staging, prod (empty for a CLI)"
              value={environments}
              onChange={(e) => setEnvironments(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {app ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
