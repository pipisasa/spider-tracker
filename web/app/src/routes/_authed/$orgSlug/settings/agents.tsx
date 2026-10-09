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
import { apiUrl } from "@/lib/api";
import { agentsQuery, useCreateAgent, useCreateApiKey, useRevokeApiKey } from "@/lib/work";
import type { AgentDto, CreatedApiKeyDto } from "@repo/core/contracts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authed/$orgSlug/settings/agents")({
  beforeLoad: ({ context, params }) => {
    const role = context.membership.actor.role;
    if (role !== "owner" && role !== "admin") throw redirect({ to: "/$orgSlug", params });
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(agentsQuery(params.orgSlug)),
  component: AgentsPage,
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function AgentsPage() {
  const { orgSlug } = Route.useParams();
  const { data: agents } = useSuspenseQuery(agentsQuery(orgSlug));
  const [newKeyFor, setNewKeyFor] = useState<AgentDto | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedApiKeyDto | null>(null);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Agents are members that act through the API with their own keys. Their changes show up under their name.
        </p>
      </header>

      <NewAgentForm orgSlug={orgSlug} />

      <ul className="flex flex-col gap-4">
        {agents.map((agent) => (
          <AgentCard key={agent.actor.id} orgSlug={orgSlug} agent={agent} onNewKey={() => setNewKeyFor(agent)} />
        ))}
        {agents.length === 0 && <p className="text-sm text-muted-foreground">No agents yet.</p>}
      </ul>

      <NewKeyDialog
        orgSlug={orgSlug}
        agent={newKeyFor}
        onClose={() => setNewKeyFor(null)}
        onCreated={(created) => {
          setNewKeyFor(null);
          setCreatedKey(created);
        }}
      />
      <CreatedKeyDialog orgSlug={orgSlug} created={createdKey} onClose={() => setCreatedKey(null)} />
    </main>
  );
}

function NewAgentForm({ orgSlug }: { orgSlug: string }) {
  const [name, setName] = useState("");
  const create = useCreateAgent(orgSlug);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name },
      {
        onSuccess: (agent) => {
          toast.success(`Added @${agent.actor.handle}`);
          setName("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="agent-name">New agent</Label>
        <Input id="agent-name" placeholder="e.g. Claude Code" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button type="submit" disabled={create.isPending || !name.trim()}>
        <PlusIcon />
        Add agent
      </Button>
    </form>
  );
}

function AgentCard({ orgSlug, agent, onNewKey }: { orgSlug: string; agent: AgentDto; onNewKey: () => void }) {
  const revoke = useRevokeApiKey(orgSlug);
  const active = agent.keys.filter((k) => !k.revokedAt);

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <ActorAvatar actor={agent.actor} className="size-8" />
        <div className="flex flex-col">
          <span className="font-medium">{agent.actor.name}</span>
          <span className="text-sm text-muted-foreground">@{agent.actor.handle}</span>
        </div>
        <Button variant="outline" size="sm" className="ml-auto" onClick={onNewKey}>
          <KeyRoundIcon />
          New key
        </Button>
      </div>
      {active.length > 0 ? (
        <ul className="divide-y rounded-md border text-sm">
          {active.map((key) => (
            <li key={key.id} className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium">{key.name}</span>
              <code className="text-xs text-muted-foreground">{key.prefix}…</code>
              <span className="ml-auto text-xs text-muted-foreground">
                {key.lastUsedAt ? `Used ${dateFormat.format(new Date(key.lastUsedAt))}` : "Never used"}
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
      )}
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
            <DialogDescription>Name it after where it will be used, so you know what to revoke later.</DialogDescription>
          </DialogHeader>
          <Input autoFocus placeholder="e.g. MacBook" value={name} onChange={(e) => setName(e.target.value)} />
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
          <DialogDescription>It won't be shown again. Store it somewhere private, not in a repository.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">{created?.secret}</code>
          <Button variant="outline" size="icon" onClick={copy} aria-label="Copy key">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Use it as a Bearer token:</span>
          <code className="rounded-md border bg-muted px-3 py-2 text-xs break-all">
            curl -H "Authorization: Bearer $SPIDER_TOKEN" {apiUrl}/v1/orgs/{orgSlug}/projects
          </code>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
