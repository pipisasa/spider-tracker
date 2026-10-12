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
  githubQuery,
  useDisconnectGithubInstallation,
  useStartGithubInstall,
  useSyncGithubInstallation,
} from "@/lib/work";
import type { GithubInstallationDto } from "@repo/core/contracts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

// Settings → GitHub (ST-82): connect the GitHub App to the organization. "Connect" goes to GitHub,
// which returns through the API's /github/setup to this page with ?connected=<id>, ?error=<reason>
// or ?requested=1. Everyone reads; owners and admins connect, sync and disconnect.

type Search = { connected?: string; error?: string; requested?: string };

const SETUP_ERRORS: Record<string, string> = {
  missing_installation: "GitHub didn't say which installation to connect. Try again.",
  not_verified:
    "GitHub didn't confirm who you are. The App must ask users to authorize it during installation; check its settings, then try again.",
  no_access: "Your GitHub account can't access that installation.",
  not_found: "GitHub doesn't know that installation any more. Try installing again.",
  other_organization: "That GitHub installation is already connected to another organization.",
  conflict: "Couldn't connect the installation. Reload and try again.",
  forbidden: "Only owners and admins can connect GitHub.",
  github_unavailable: "GitHub couldn't be reached. Try again in a minute.",
};

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : undefined);

export const Route = createFileRoute("/_authed/$orgSlug/settings/github")({
  validateSearch: (search: Record<string, unknown>): Search => {
    const result: Search = {};
    const connected = text(search.connected);
    const error = text(search.error);
    const requested = text(search.requested);
    if (connected) result.connected = connected;
    if (error) result.error = error;
    if (requested) result.requested = requested;
    return result;
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(githubQuery(params.orgSlug)),
  component: GithubSettingsPage,
});

function GithubSettingsPage() {
  const { orgSlug } = Route.useParams();
  const search = Route.useSearch();
  const { membership } = Route.useRouteContext();
  const canManage = membership.actor.role === "owner" || membership.actor.role === "admin";
  const { data: github } = useSuspenseQuery(githubQuery(orgSlug));
  const start = useStartGithubInstall(orgSlug);
  const connected = github.installations.find((i) => String(i.id) === search.connected);

  function connect() {
    start.mutate(undefined, {
      onSuccess: ({ url }) => {
        window.location.assign(url);
      },
    });
  }

  return (
    <>
      <header className="border-b px-4 py-3 md:px-6">
        <h1 className="font-semibold">GitHub</h1>
      </header>
      <main className="flex max-w-3xl flex-col gap-6 px-4 py-4 md:px-6">
        <p className="text-sm text-muted-foreground">
          Install the Spider Tracker GitHub App on a GitHub account to connect its repositories: those the organization
          already has under{" "}
          <Link to="/$orgSlug/settings/repos" params={{ orgSlug }} className="underline">
            Repos
          </Link>{" "}
          are linked, the others are added. Attach them to projects there.
          {canManage ? "" : " Owners and admins connect GitHub."}
        </p>

        {search.error && (
          <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">
            {SETUP_ERRORS[search.error] ?? "Couldn't connect GitHub. Try again."}
          </p>
        )}
        {connected && (
          <p role="status" className="rounded-md border px-3 py-2 text-sm">
            Connected the installation on {connected.account}.
          </p>
        )}
        {search.requested && (
          <p role="status" className="rounded-md border px-3 py-2 text-sm">
            GitHub asked the account&apos;s owners to approve the installation. Connect again once they have.
          </p>
        )}

        {!github.configured ? (
          <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
            GitHub isn&apos;t configured on this server: it needs the GitHub App&apos;s settings (the{" "}
            <code className="text-xs">GITHUB_APP_*</code> variables). Repos can still be added by URL under Repos.
          </p>
        ) : (
          canManage && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Connect a GitHub account</span>
                <span className="text-xs text-muted-foreground">
                  Opens GitHub to install{" "}
                  <a
                    href={`https://github.com/apps/${github.appSlug ?? ""}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {github.appSlug}
                  </a>{" "}
                  and pick repositories; you come back here.
                </span>
              </div>
              <Button className="ml-auto" onClick={connect} disabled={start.isPending || start.isSuccess}>
                Connect
              </Button>
            </div>
          )
        )}

        {github.installations.length === 0 && (
          <p className="text-sm text-muted-foreground">No GitHub installations connected.</p>
        )}
        {github.installations.map((installation) => (
          <InstallationCard
            key={installation.id}
            orgSlug={orgSlug}
            installation={installation}
            canManage={canManage}
            configured={github.configured}
          />
        ))}
      </main>
    </>
  );
}

function InstallationCard({
  orgSlug,
  installation,
  canManage,
  configured,
}: {
  orgSlug: string;
  installation: GithubInstallationDto;
  canManage: boolean;
  configured: boolean;
}) {
  const sync = useSyncGithubInstallation(orgSlug);
  const disconnect = useDisconnectGithubInstallation(orgSlug);
  const [confirm, setConfirm] = useState(false);

  return (
    <section className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`https://github.com/${installation.account}`}
          target="_blank"
          rel="noreferrer"
          className="truncate font-medium hover:underline"
        >
          {installation.account}
        </a>
        <Badge variant="outline">{installation.accountType === "Organization" ? "organization" : "user"}</Badge>
        <Badge variant="outline">
          {installation.repositorySelection === "all" ? "all repositories" : "selected repositories"}
        </Badge>
        {installation.suspended && <Badge variant="destructive">suspended</Badge>}
        {canManage && (
          <div className="ml-auto flex gap-2">
            {configured && (
              <Button
                variant="outline"
                size="sm"
                disabled={sync.isPending}
                onClick={() => sync.mutate(installation.id)}
              >
                Sync
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Repos</span>
        {installation.repos.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
        {installation.repos.map((repo) => (
          <Badge key={repo} variant="secondary">
            {repo}
          </Badge>
        ))}
      </div>

      <a
        href={installation.settingsUrl}
        target="_blank"
        rel="noreferrer"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:underline"
      >
        Choose repositories on GitHub
        <ExternalLinkIcon className="size-3" />
      </a>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {installation.account}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its repos stay under Repos, without the GitHub link. The App stays installed on GitHub until you
              uninstall it there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => disconnect.mutate(installation.id)}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
