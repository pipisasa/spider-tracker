import { ActorAvatar } from "@/components/task-fields";
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
import {
  claudeCodePrompt,
  inviteLink as inviteLinkFor,
} from "@/lib/agent-invite-instructions";
import { apiUrl } from "@/lib/api";
import {
  agentInvitesQuery,
  agentsQuery,
  projectsQuery,
  useCreateAgent,
  useCreateAgentInvite,
  useRevokeAgentInvite,
  useCreateApiKey,
  useDeleteAgent,
  useRevokeApiKey,
  useUpdateAgent,
} from "@/lib/work";
import type {
  AgentDto,
  AgentInviteDto,
  CreatedAgentInviteDto,
  CreatedApiKeyDto,
} from "@repo/core/contracts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authed/$orgSlug/settings/agents")({
  beforeLoad: ({ context, params }) => {
    if (context.membership.actor.role === "guest")
      throw redirect({ to: "/$orgSlug", params });
  },
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(agentsQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(agentInvitesQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(projectsQuery(params.orgSlug)),
    ]),
  component: AgentsPage,
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function AgentsPage() {
  const { orgSlug } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { data: agents } = useSuspenseQuery(agentsQuery(orgSlug));
  const { data: invites } = useSuspenseQuery(agentInvitesQuery(orgSlug));
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<AgentDto | null>(null);
  const [deleting, setDeleting] = useState<AgentDto | null>(null);
  const [newKeyFor, setNewKeyFor] = useState<AgentDto | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKeyDto | null>(null);

  const mine = agents.filter((a) => a.ownerId === membership.actor.id);
  const others = agents.filter((a) => a.ownerId !== membership.actor.id);
  const card = (agent: AgentDto, showOwner: boolean) => (
    <AgentCard
      key={agent.actor.id}
      orgSlug={orgSlug}
      agent={agent}
      showOwner={showOwner}
      onEdit={() => setEditing(agent)}
      onDelete={() => setDeleting(agent)}
      onNewKey={() => setNewKeyFor(agent)}
    />
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <header className="flex items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Agents are members that act through the API with their own keys.
            Their changes show up under their name. You manage the agents you
            create; owners and admins can manage every agent.
          </p>
        </div>
        <div className="ml-auto flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => setInviting(true)}>
            <UserPlusIcon />
            Invite agent
          </Button>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            New agent
          </Button>
        </div>
      </header>

      {invites.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Waiting for setup</h2>
          <ul className="flex flex-col gap-2">
            {invites.map((invite) => (
              <PendingInvite
                key={invite.id}
                orgSlug={orgSlug}
                invite={invite}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">My agents</h2>
        <ul className="flex flex-col gap-4">
          {mine.map((agent) => card(agent, false))}
          {mine.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No agents yet. Create one here, or run <code>spider login</code>.
            </p>
          )}
        </ul>
      </section>

      {others.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Other agents</h2>
          <ul className="flex flex-col gap-4">
            {others.map((agent) => card(agent, true))}
          </ul>
        </section>
      )}

      <InviteAgentDialog
        orgSlug={orgSlug}
        open={inviting}
        onClose={() => setInviting(false)}
      />
      <AgentFormDialog
        orgSlug={orgSlug}
        open={creating}
        agent={null}
        onClose={() => setCreating(false)}
      />
      <AgentFormDialog
        orgSlug={orgSlug}
        open={!!editing}
        agent={editing}
        onClose={() => setEditing(null)}
      />
      <DeleteAgentDialog
        orgSlug={orgSlug}
        agent={deleting}
        onClose={() => setDeleting(null)}
      />
      <NewKeyDialog
        orgSlug={orgSlug}
        agent={newKeyFor}
        onClose={() => setNewKeyFor(null)}
        onCreated={(created) => {
          setNewKeyFor(null);
          setCreatedKey(created);
        }}
      />
      <CreatedKeyDialog
        orgSlug={orgSlug}
        created={createdKey}
        onClose={() => setCreatedKey(null)}
      />
    </main>
  );
}

function AgentFormDialog({
  orgSlug,
  open,
  agent,
  onClose,
}: {
  orgSlug: string;
  open: boolean;
  /** Null to create a new agent. */
  agent: AgentDto | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [description, setDescription] = useState("");
  const create = useCreateAgent(orgSlug);
  const update = useUpdateAgent(orgSlug);
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setName(agent?.actor.name ?? "");
    setHandle(agent?.actor.handle ?? "");
    setDescription(agent?.description ?? "");
  }, [open, agent]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const onError = (err: Error) => toast.error(err.message);
    if (agent) {
      update.mutate(
        {
          agentId: agent.actor.id,
          input: { name, handle, description: description.trim() || null },
        },
        {
          onSuccess: (updated) => {
            toast.success(`Saved @${updated.actor.handle}`);
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(
        {
          name,
          handle: handle.trim() || undefined,
          description: description.trim() || undefined,
        },
        {
          onSuccess: (created) => {
            toast.success(`Added @${created.actor.handle}`);
            onClose();
          },
          onError,
        },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {agent ? `Edit ${agent.actor.name}` : "New agent"}
            </DialogTitle>
            <DialogDescription>
              {agent
                ? "Its history keeps the new name."
                : "It will belong to you; then create a key for it."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              autoFocus
              placeholder="e.g. Claude Code"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-handle">Handle</Label>
            <Input
              id="agent-handle"
              placeholder={agent ? undefined : "From the name"}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-description">Description</Label>
            <Textarea
              id="agent-description"
              placeholder="What it does"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={pending || !name.trim() || (!!agent && !handle.trim())}
            >
              {agent ? "Save" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAgentDialog({
  orgSlug,
  agent,
  onClose,
}: {
  orgSlug: string;
  agent: AgentDto | null;
  onClose: () => void;
}) {
  const remove = useDeleteAgent(orgSlug);

  function confirm() {
    if (!agent) return;
    remove.mutate(agent.actor.id, {
      onSuccess: () => {
        toast.success(`Deleted @${agent.actor.handle}`);
        onClose();
      },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <Dialog open={!!agent} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {agent?.actor.name}?</DialogTitle>
          <DialogDescription>
            Its keys stop working right away. Its comments, history and
            assignments stay under its name.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={confirm}
          >
            Delete agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentCard({
  orgSlug,
  agent,
  showOwner,
  onEdit,
  onDelete,
  onNewKey,
}: {
  orgSlug: string;
  agent: AgentDto;
  showOwner: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onNewKey: () => void;
}) {
  const revoke = useRevokeApiKey(orgSlug);
  const active = agent.keys.filter((k) => !k.revokedAt);

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <ActorAvatar actor={agent.actor} className="size-8" />
        <div className="flex min-w-0 flex-col">
          <span className="font-medium">{agent.actor.name}</span>
          <span className="text-sm text-muted-foreground">
            @{agent.actor.handle}
            {showOwner && ` · owned by ${agent.owner.name}`}
          </span>
        </div>
        {agent.canManage && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={onNewKey}>
              <KeyRoundIcon />
              New key
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit agent"
              onClick={onEdit}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete agent"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>
      {agent.description && (
        <p className="text-sm text-muted-foreground">{agent.description}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {!agent.projects
          ? "All projects"
          : agent.projects.length > 0
            ? `Projects: ${agent.projects.map((p) => p.key).join(", ")}`
            : "No projects (its projects were deleted)"}
      </p>
      {agent.canManage &&
        (active.length > 0 ? (
          <ul className="divide-y rounded-md border text-sm">
            {active.map((key) => (
              <li key={key.id} className="flex items-center gap-3 px-3 py-2">
                <span className="font-medium">{key.name}</span>
                <code className="text-xs text-muted-foreground">
                  {key.prefix}…
                </code>
                <span className="ml-auto text-xs text-muted-foreground">
                  {key.lastUsedAt
                    ? `Used ${dateFormat.format(new Date(key.lastUsedAt))}`
                    : "Never used"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(key.id, {
                      onSuccess: () => toast.success(`Revoked ${key.name}`),
                      onError: (err) => toast.error(err.message),
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No active keys.</p>
        ))}
    </li>
  );
}

function NewKeyDialog({
  orgSlug,
  agent,
  onClose,
  onCreated,
}: {
  orgSlug: string;
  agent: AgentDto | null;
  onClose: () => void;
  onCreated: (created: CreatedApiKeyDto) => void;
}) {
  const [name, setName] = useState("");
  const create = useCreateApiKey(orgSlug);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!agent || !name.trim()) return;
    create.mutate(
      { agentId: agent.actor.id, name },
      {
        onSuccess: (created) => {
          setName("");
          onCreated(created);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={!!agent} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New key for {agent?.actor.name}</DialogTitle>
            <DialogDescription>
              Name it after where it will be used, so you know what to revoke
              later.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="e.g. MacBook"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreatedKeyDialog({
  orgSlug,
  created,
  onClose,
}: {
  orgSlug: string;
  created: CreatedApiKeyDto | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!created) return;
    await navigator.clipboard.writeText(created.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={!!created} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Copy your key now</DialogTitle>
          <DialogDescription>
            It won't be shown again. Store it somewhere private, not in a
            repository.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">
            {created?.secret}
          </code>
          <Button
            variant="outline"
            size="icon"
            onClick={copy}
            aria-label="Copy key"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            Use it as a Bearer token:
          </span>
          <code className="rounded-md border bg-muted px-3 py-2 text-xs break-all">
            curl -H "Authorization: Bearer $SPIDER_TOKEN" {apiUrl}/v1/orgs/
            {orgSlug}/projects
          </code>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const inviteLink = (code: string) =>
  inviteLinkFor(window.location.origin, code);

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">
          {value}
        </code>
        <Button
          variant="outline"
          size="icon"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

function CopyPromptButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      Copy prompt for Claude Code
    </Button>
  );
}

function PendingInvite({
  orgSlug,
  invite,
}: {
  orgSlug: string;
  invite: AgentInviteDto;
}) {
  const revoke = useRevokeAgentInvite(orgSlug);

  return (
    <li className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
      <div className="flex min-w-0 flex-col">
        <code className="font-medium">{invite.code}</code>
        <span className="text-xs text-muted-foreground">
          {invite.status === "expired"
            ? "Expired"
            : `Expires ${dateFormat.format(new Date(invite.expiresAt))}`}{" "}
          · Projects: {invite.projects.map((p) => p.key).join(", ")}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto text-destructive hover:text-destructive"
        disabled={revoke.isPending}
        onClick={() =>
          revoke.mutate(invite.id, {
            onSuccess: () => toast.success(`Revoked ${invite.code}`),
            onError: (err) => toast.error(err.message),
          })
        }
      >
        Revoke
      </Button>
    </li>
  );
}

const EXPIRY_DAYS = [1, 7, 30] as const;

function InviteAgentDialog({
  orgSlug,
  open,
  onClose,
}: {
  orgSlug: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data: projects } = useSuspenseQuery(projectsQuery(orgSlug));
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState<number>(1);
  const [created, setCreated] = useState<CreatedAgentInviteDto | null>(null);
  const create = useCreateAgentInvite(orgSlug);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setDays(1);
    setCreated(null);
  }, [open]);

  function toggle(key: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...current, key] : current.filter((k) => k !== key),
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected.length === 0) return;
    create.mutate(
      { projectKeys: selected, expiresInDays: days },
      { onSuccess: setCreated, onError: (err) => toast.error(err.message) },
    );
  }

  const code = created?.invite.code;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {code ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite code {code}</DialogTitle>
              <DialogDescription>
                Give it to the agent. It works once, until{" "}
                {dateFormat.format(new Date(created.invite.expiresAt))}, and the
                agent will see only{" "}
                {created.invite.projects.map((p) => p.key).join(", ")}.
              </DialogDescription>
            </DialogHeader>
            <CopyPromptButton value={claudeCodePrompt(inviteLink(code))} />
            <p className="text-xs text-muted-foreground">
              Paste this into Claude Code on the machine where the agent will
              run.
            </p>
            <CopyLine label="Code" value={code} />
            <CopyLine label="Link" value={inviteLink(code)} />
            <CopyLine label="CLI" value={`spider accept-invite ${code}`} />
            <CopyLine
              label="Claude Code"
              value={`/spider-tracker:create-agent ${code}`}
            />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite an agent</DialogTitle>
              <DialogDescription>
                The agent sets itself up with a one-time code and gets its own
                key. It belongs to you and sees only the projects you pick.
              </DialogDescription>
            </DialogHeader>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Projects</legend>
              {projects.map((project) => (
                <label
                  key={project.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selected.includes(project.key)}
                    onChange={(e) => toggle(project.key, e.target.checked)}
                  />
                  <span className="font-medium">{project.key}</span>
                  <span className="text-muted-foreground">{project.name}</span>
                </label>
              ))}
              {projects.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No projects yet.
                </p>
              )}
            </fieldset>
            <div className="flex flex-col gap-2">
              <Label>Expires after</Label>
              <div className="flex gap-2">
                {EXPIRY_DAYS.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={days === d ? "default" : "outline"}
                    onClick={() => setDays(d)}
                  >
                    {d === 1 ? "1 day" : `${d} days`}
                  </Button>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={create.isPending || selected.length === 0}
              >
                Create invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
