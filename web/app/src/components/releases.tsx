import { StatusIcon, formatDay } from "@/components/task-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  releaseCandidatesQuery,
  reposQuery,
  useAddToRelease,
  useCreateRelease,
  useRemoveFromRelease,
  useUpdateRelease,
} from "@/lib/work";
import {
  appsAwaitingProduction,
  deploymentCells,
  shippingLabel,
} from "@repo/core/board";
import type {
  ProjectDetailDto,
  ReleaseDto,
  StatusDto,
  TaskShippingDto,
} from "@repo/core/contracts";
import { appVersionProblem, type ReleaseAppInput } from "@repo/core/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PackageIcon, PlusIcon, RocketIcon, XIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

// Releases (ST-93): shipping chips on Done cards, release cards, the Releases view and the
// release panel of a release's page. Done means finished; a release ships Done tasks.

/** "2026.10.13": today's date version, the usual name of a date-versioned release. */
export const todayVersion = (now = new Date()) =>
  `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;

const chipStyles: Record<TaskShippingDto["state"], string> = {
  not_in_release:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  in_release: "border-dashed text-muted-foreground",
  shipped:
    "border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  no_code: "border-transparent text-muted-foreground",
};

/** A Done task's shipping state: not in a release / "2026.10.14 · on staging" / "shipped 2026.10.12" / no code. */
export function ShippingChip({
  shipping,
  className = "",
}: {
  shipping: TaskShippingDto | null | undefined;
  className?: string;
}) {
  const label = shippingLabel(shipping);
  if (!shipping || !label) return null;
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-md border px-1.5 text-xs ${chipStyles[shipping.state]} ${className}`}
      title={shipping.release ? `Release ${shipping.release.key}` : undefined}
    >
      {shipping.state !== "no_code" && (
        <PackageIcon className="size-3" aria-hidden />
      )}
      {label}
    </span>
  );
}

export function AppChips({ release }: { release: Pick<ReleaseDto, "apps"> }) {
  if (release.apps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {release.apps.map((a) => (
        <span
          key={a.appId}
          className="rounded bg-muted px-1.5 font-mono text-[11px]"
        >
          <span className="font-sans font-medium">{a.name}</span> {a.version}
        </span>
      ))}
    </div>
  );
}

/** A release card's body: version, key, apps, task keys and counts. */
export function ReleaseCardBody({ release }: { release: ReleaseDto }) {
  const projects = new Set(release.tasks.map((t) => t.projectKey)).size;
  const shown = release.tasks.slice(0, 6);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{release.title}</span>
        <span className="text-xs text-muted-foreground">{release.key}</span>
      </div>
      <AppChips release={release} />
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs text-muted-foreground">
          {shown.map((t) => (
            <span key={t.id}>{t.key}</span>
          ))}
          {release.tasks.length > shown.length && (
            <span>+{release.tasks.length - shown.length}</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {release.tasks.length} task{release.tasks.length === 1 ? "" : "s"}
          {projects > 1 ? ` · ${projects} projects` : ""}
        </span>
        {release.shippedAt ? (
          <span>shipped {formatDay(release.shippedAt.slice(0, 10))}</span>
        ) : release.targetDate ? (
          <span>target {formatDay(release.targetDate)}</span>
        ) : null}
      </div>
    </div>
  );
}

interface AppChoice {
  key: string;
  repo: string;
  name: string;
  versioning: "date" | "semver";
}

/** Apps of the repos the viewer can see, with a version field each; checked ones are shipped. */
function AppVersionsField({
  orgSlug,
  value,
  onChange,
}: {
  orgSlug: string;
  value: ReleaseAppInput[];
  onChange: (apps: ReleaseAppInput[]) => void;
}) {
  const { data: repos = [] } = useQuery(reposQuery(orgSlug));
  const choices: AppChoice[] = useMemo(
    () =>
      repos
        .filter((r) => r.projects.length > 0)
        .flatMap((r) =>
          r.apps.map((a) => ({
            key: `${r.fullName}:${a.name}`,
            repo: r.fullName,
            name: a.name,
            versioning: a.versioning,
          })),
        ),
    [repos],
  );
  if (choices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No apps yet. Owners and admins add repos and apps in Settings → Repos.
      </p>
    );
  }
  const find = (c: AppChoice) =>
    value.find((v) => v.repo === c.repo && v.app === c.name);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Apps and versions</legend>
      {choices.map((choice) => {
        const current = find(choice);
        const problem = current
          ? appVersionProblem(choice.versioning, current.version)
          : null;
        return (
          <div
            key={choice.key}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <label className="flex min-w-40 items-center gap-2">
              <input
                type="checkbox"
                checked={current !== undefined}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [
                          ...value,
                          {
                            repo: choice.repo,
                            app: choice.name,
                            version:
                              choice.versioning === "date"
                                ? todayVersion()
                                : "",
                          },
                        ]
                      : value.filter((v) => v !== current),
                  )
                }
              />
              <span className="font-medium">{choice.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {choice.repo}
              </span>
            </label>
            {current && (
              <Input
                className="h-8 w-40 font-mono"
                aria-label={`${choice.name} version`}
                aria-invalid={problem !== null}
                placeholder={
                  choice.versioning === "date" ? "2026.10.13" : "1.4.0"
                }
                value={current.version}
                onChange={(e) =>
                  onChange(
                    value.map((v) =>
                      v === current ? { ...v, version: e.target.value } : v,
                    ),
                  )
                }
              />
            )}
            {problem && current?.version && (
              <span className="text-xs text-destructive">{problem}</span>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

export function NewReleaseDialog({
  orgSlug,
  project,
  defaultStatusId,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  project: ProjectDetailDto;
  defaultStatusId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = useState(todayVersion());
  const [apps, setApps] = useState<ReleaseAppInput[]>([]);
  const create = useCreateRelease(orgSlug, project.key);
  const invalid = apps.some((a) => !a.version.trim());

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      { title, apps, statusId: defaultStatusId },
      {
        onSuccess: () => {
          setApps([]);
          setTitle(todayVersion());
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New release in {project.name}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Version</span>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="2026.10.13"
            />
          </label>
          <AppVersionsField orgSlug={orgSlug} value={apps} onChange={setApps} />
          <p className="text-xs text-muted-foreground">
            Add Done tasks afterwards: drag them onto the release card on the
            board, or from the release&apos;s page.
          </p>
          <DialogFooter>
            <Button
              type="submit"
              disabled={create.isPending || !title.trim() || invalid}
            >
              {create.isPending ? "Creating…" : "Create release"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Releases view of a project, which is also its changelog: releases in flight at the top,
 * shipped ones below (newest first, with their tasks), filterable by app.
 */
export function ReleasesView({
  orgSlug,
  project,
  releases,
  canWrite,
}: {
  orgSlug: string;
  project: ProjectDetailDto;
  releases: ReleaseDto[];
  canWrite: boolean;
}) {
  const [app, setApp] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const { data: candidates = [] } = useQuery(
    releaseCandidatesQuery(orgSlug, project.key),
  );
  const appNames = [
    ...new Set(releases.flatMap((r) => r.apps.map((a) => a.name))),
  ].sort();
  const matches = (r: ReleaseDto) =>
    app === null || r.apps.some((a) => a.name === app);
  const inFlight = releases.filter(
    (r) => r.status.category !== "done" && r.status.category !== "canceled",
  );
  const shipped = releases
    .filter((r) => r.status.category === "done" && matches(r))
    .sort((a, b) => (b.shippedAt ?? "").localeCompare(a.shippedAt ?? ""));
  const statusOf = (r: ReleaseDto): Pick<StatusDto, "category" | "color"> =>
    project.workflows.release.find((s) => s.id === r.statusId) ?? {
      category: r.status.category,
      color: null,
    };

  return (
    <main className="flex flex-col gap-6 overflow-y-auto px-4 py-4 md:px-6">
      <section aria-labelledby="in-flight" className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h2 id="in-flight" className="font-semibold">
            In flight
          </h2>
          <span className="text-sm text-muted-foreground">
            {inFlight.length}
          </span>
          {canWrite && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => setNewOpen(true)}
            >
              <PlusIcon />
              New release
            </Button>
          )}
        </header>
        {inFlight.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No release on its way.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {inFlight.map((r) => (
              <li key={r.id}>
                <Link
                  to="/$orgSlug/tasks/$taskKey"
                  params={{ orgSlug, taskKey: r.key }}
                  className="grid gap-2 px-3 py-2.5 hover:bg-muted md:grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1.4fr)_auto] md:items-center"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{r.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.key}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-sm">
                    <StatusIcon status={statusOf(r)} className="size-3.5" />
                    {r.status.name}
                  </span>
                  <AppChips release={r} />
                  <span className="text-sm text-muted-foreground">
                    {r.tasks.length} task{r.tasks.length === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {candidates.length > 0 && (
          <p
            role="status"
            className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
          >
            {candidates.length} Done task
            {candidates.length === 1 ? " has" : "s have"} code that isn&apos;t
            in a release:{" "}
            {candidates
              .slice(0, 5)
              .map((t) => t.key)
              .join(", ")}
            {candidates.length > 5 ? "…" : ""}. Add{" "}
            {candidates.length === 1 ? "it" : "them"} to a release from the
            board or the release&apos;s page.
          </p>
        )}
      </section>

      <section aria-labelledby="shipped" className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h2 id="shipped" className="font-semibold">
            Shipped
          </h2>
          <span className="text-sm text-muted-foreground">the changelog</span>
          {appNames.length > 0 && (
            <div
              role="group"
              aria-label="Filter by app"
              className="ml-auto flex flex-wrap gap-1"
            >
              {[null, ...appNames].map((name) => (
                <Button
                  key={name ?? "all"}
                  size="sm"
                  variant={app === name ? "secondary" : "ghost"}
                  aria-pressed={app === name}
                  onClick={() => setApp(name)}
                >
                  {name ?? "All apps"}
                </Button>
              ))}
            </div>
          )}
        </header>
        {shipped.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing shipped{app ? ` for ${app}` : ""} yet.
          </p>
        ) : (
          <ol className="flex max-w-3xl flex-col">
            {shipped.map((r) => (
              <li
                key={r.id}
                className="grid gap-2 border-b py-4 last:border-b-0 md:grid-cols-[9rem_minmax(0,1fr)] md:gap-5"
              >
                <div className="flex flex-col gap-1 text-sm">
                  <Link
                    to="/$orgSlug/tasks/$taskKey"
                    params={{ orgSlug, taskKey: r.key }}
                    className="font-mono text-xs text-muted-foreground hover:underline"
                  >
                    {r.key}
                  </Link>
                  {r.shippedAt && (
                    <time className="text-muted-foreground">
                      {formatDay(r.shippedAt.slice(0, 10))}
                    </time>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  <h3 className="font-semibold">{r.title}</h3>
                  <AppChips release={r} />
                  {r.tasks.length > 0 && (
                    <ul className="list-disc pl-5 text-sm">
                      {r.tasks.map((t) => (
                        <li key={t.id}>
                          {t.title}{" "}
                          <Link
                            to="/$orgSlug/tasks/$taskKey"
                            params={{ orgSlug, taskKey: t.key }}
                            className="font-mono text-xs text-muted-foreground hover:underline"
                          >
                            {t.key}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <NewReleaseDialog
        orgSlug={orgSlug}
        project={project}
        open={newOpen}
        onOpenChange={setNewOpen}
      />
    </main>
  );
}

/** A release's page section: apps and versions, repos, and its tasks (add candidates, remove). */
export function ReleasePanel({
  orgSlug,
  release,
  canWrite,
}: {
  orgSlug: string;
  release: ReleaseDto;
  canWrite: boolean;
}) {
  const open =
    release.status.category !== "done" &&
    release.status.category !== "canceled";
  const add = useAddToRelease(orgSlug);
  const remove = useRemoveFromRelease(orgSlug);
  const update = useUpdateRelease(orgSlug);
  const [editingApps, setEditingApps] = useState(false);
  const [apps, setApps] = useState<ReleaseAppInput[]>([]);
  const { data: candidates = [] } = useQuery({
    ...releaseCandidatesQuery(orgSlug),
    enabled: canWrite && open,
  });
  const [pick, setPick] = useState("");

  return (
    <section
      aria-labelledby="release-panel"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <PackageIcon className="size-4 text-muted-foreground" aria-hidden />
        <h2 id="release-panel" className="text-sm font-medium">
          Release {release.title}
        </h2>
        <span className="text-xs text-muted-foreground">
          {release.repos.map((r) => r.fullName).join(", ") || "no repos"}
        </span>
        {canWrite && !editingApps && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setApps(
                release.apps.map((a) => ({
                  repo: a.repo,
                  app: a.name,
                  version: a.version,
                })),
              );
              setEditingApps(true);
            }}
          >
            Edit apps
          </Button>
        )}
      </header>
      {editingApps ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate(
              { releaseKey: release.key, input: { apps } },
              { onSuccess: () => setEditingApps(false) },
            );
          }}
        >
          <AppVersionsField orgSlug={orgSlug} value={apps} onChange={setApps} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={update.isPending}>
              Save apps
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setEditingApps(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : release.apps.length ? (
        <AppChips release={release} />
      ) : (
        <p className="text-sm text-muted-foreground">No apps yet.</p>
      )}
      <ReleaseDeployments release={release} />
      <h3 className="text-sm font-medium">
        Tasks{" "}
        <span className="text-muted-foreground">{release.tasks.length}</span>
      </h3>
      {release.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks yet. Add Done tasks below, or drag them onto the release on
          the board.
        </p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {release.tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-2 py-1.5">
              <Link
                to="/$orgSlug/tasks/$taskKey"
                params={{ orgSlug, taskKey: t.key }}
                className="font-mono text-xs text-muted-foreground hover:underline"
              >
                {t.key}
              </Link>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.status.category !== "done" && (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {t.status.name}
                </span>
              )}
              {t.shippedAt && (
                <span className="text-xs text-muted-foreground">shipped</span>
              )}
              {canWrite && open && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Remove ${t.key} from the release`}
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({ releaseKey: release.key, taskKey: t.key })
                  }
                >
                  <XIcon className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && open && candidates.length > 0 && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick)
              add.mutate(
                { releaseKey: release.key, taskKeys: [pick] },
                { onSuccess: () => setPick("") },
              );
          }}
        >
          <select
            aria-label="Done task to add"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Add a Done task not in a release…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.key}>
                {t.key} {t.title}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" disabled={!pick || add.isPending}>
            Add
          </Button>
        </form>
      )}
    </section>
  );
}

const deployedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A release's deployments (ST-94), per app and environment in deploy order: the latest commit, when
 * and by whom, or "not deployed". Recorded by `spider release deploy` (the deploy scripts call it).
 */
export function ReleaseDeployments({ release }: { release: ReleaseDto }) {
  const cells = deploymentCells(release);
  if (cells.length === 0) return null;
  const awaiting = appsAwaitingProduction(release);
  const open =
    release.status.category !== "done" &&
    release.status.category !== "canceled";
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <RocketIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Deployments
      </h3>
      <ul
        className="divide-y rounded-md border text-sm"
        aria-label="Deployments by app and environment"
      >
        {cells.map((cell) => (
          <li
            key={`${cell.appId}:${cell.environment}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5"
          >
            <span className="font-medium">{cell.app}</span>
            <span
              className={`rounded px-1.5 text-xs ${cell.production ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300" : "bg-muted"}`}
            >
              {cell.environment}
            </span>
            {cell.latest ? (
              <span className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono" title={cell.latest.commitSha}>
                  {cell.latest.commitSha.slice(0, 7)}
                </span>
                <span>
                  {deployedAtFormat.format(new Date(cell.latest.createdAt))}
                </span>
                {cell.latest.deployedBy && (
                  <span>@{cell.latest.deployedBy.handle}</span>
                )}
                {cell.count > 1 && <span>· {cell.count} deploys</span>}
              </span>
            ) : (
              <span className="flex-1 text-right text-xs text-muted-foreground">
                not deployed
              </span>
            )}
          </li>
        ))}
      </ul>
      {open && awaiting.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Released needs{" "}
          {awaiting.map((c) => `${c.app} on ${c.environment}`).join(", ")}.
          Record a deploy with{" "}
          <code className="font-mono">
            spider release deploy {release.key} --app {awaiting[0]?.app} --env{" "}
            {awaiting[0]?.environment}
          </code>
        </p>
      )}
    </div>
  );
}
