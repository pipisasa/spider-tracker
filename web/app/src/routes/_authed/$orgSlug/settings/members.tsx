import { ActorAvatar } from "@/components/task-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  agentsQuery,
  invitationsQuery,
  membersQuery,
  useCreateInvitation,
  useRevokeInvitation,
} from "@/lib/work";
import type { ActorDto, ActorRole, InvitationDto } from "@repo/core/contracts";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CopyIcon, LinkIcon, PlusIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authed/$orgSlug/settings/members")({
  loader: async ({ context, params }) => {
    const role = context.membership.actor.role;
    await Promise.all([
      context.queryClient.ensureQueryData(membersQuery(params.orgSlug)),
      role === "owner" || role === "admin"
        ? context.queryClient.ensureQueryData(invitationsQuery(params.orgSlug))
        : null,
    ]);
  },
  component: MembersPage,
});

const roleOrder: Record<ActorRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  guest: 3,
};
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function MembersPage() {
  const { orgSlug } = Route.useParams();
  const { membership } = Route.useRouteContext();
  const { data: members } = useSuspenseQuery(membersQuery(orgSlug));
  const role = membership.actor.role;
  const canInvite = role === "owner" || role === "admin";
  // Owners of agents come from the agents list; guests may not see it, then agents stay flat.
  const { data: agents = [] } = useQuery({
    ...agentsQuery(orgSlug),
    enabled: role !== "guest",
  });
  const { people, agentsOf, unowned } = useMemo(() => {
    const ownerOf = new Map(agents.map((a) => [a.actor.id, a.ownerId]));
    const people = members
      .filter((m) => m.type === "human")
      .sort(
        (a, b) =>
          roleOrder[a.role] - roleOrder[b.role] || a.name.localeCompare(b.name),
      );
    const personIds = new Set(people.map((p) => p.id));
    const agentsOf = new Map<string, ActorDto[]>();
    const unowned: ActorDto[] = [];
    for (const m of members) {
      if (m.type !== "agent") continue;
      const owner = ownerOf.get(m.id);
      if (owner && personIds.has(owner))
        agentsOf.set(owner, [...(agentsOf.get(owner) ?? []), m]);
      else unowned.push(m);
    }
    for (const list of agentsOf.values())
      list.sort((a, b) => a.name.localeCompare(b.name));
    return { people, agentsOf, unowned };
  }, [members, agents]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
      <section className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Members</h1>
          <p className="text-sm text-muted-foreground">
            People in {membership.organization.name}, each with their agents.
          </p>
        </header>
        <ul className="divide-y rounded-lg border">
          {people.map((person) => {
            const own = agentsOf.get(person.id) ?? [];
            return (
              <li key={person.id} className="flex flex-col">
                <MemberRow member={person} />
                {own.length > 0 && (
                  <ul
                    aria-label={`${person.name}'s agents`}
                    className="flex flex-col pb-2 pl-11"
                  >
                    {own.map((agent) => (
                      <li key={agent.id} className="border-l">
                        <MemberRow member={agent} compact />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {unowned.map((agent) => (
            <li key={agent.id}>
              <MemberRow member={agent} />
            </li>
          ))}
        </ul>
      </section>

      {canInvite && (
        <Invitations orgSlug={orgSlug} isOwner={role === "owner"} />
      )}
    </main>
  );
}

function MemberRow({
  member,
  compact = false,
}: {
  member: ActorDto;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex items-center gap-3 px-4 py-1.5"
          : "flex items-center gap-3 px-4 py-3"
      }
    >
      <ActorAvatar actor={member} className={compact ? "size-6" : "size-8"} />
      <div className="flex min-w-0 flex-col">
        <span
          className={
            compact ? "truncate text-sm font-medium" : "truncate font-medium"
          }
        >
          {member.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          @{member.handle}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {member.type === "agent" ? (
          <Badge variant="outline">Agent</Badge>
        ) : (
          <Badge variant="secondary" className="capitalize">
            {member.role}
          </Badge>
        )}
      </div>
    </div>
  );
}

function Invitations({
  orgSlug,
  isOwner,
}: {
  orgSlug: string;
  isOwner: boolean;
}) {
  const { data: invitations = [] } = useQuery(invitationsQuery(orgSlug));

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Invitation codes</h2>
        <p className="text-sm text-muted-foreground">
          Anyone signed in with a code can join with its role, until it expires,
          is used up or revoked.
        </p>
      </header>
      <NewInvitationForm orgSlug={orgSlug} isOwner={isOwner} />
      {invitations.length > 0 ? (
        <ul className="divide-y rounded-lg border text-sm">
          {invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              orgSlug={orgSlug}
              invitation={invitation}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No invitation codes yet.
        </p>
      )}
    </section>
  );
}

function NewInvitationForm({
  orgSlug,
  isOwner,
}: {
  orgSlug: string;
  isOwner: boolean;
}) {
  const [role, setRole] = useState<InvitationDto["role"]>("member");
  const [days, setDays] = useState("7");
  const [maxUses, setMaxUses] = useState("");
  const create = useCreateInvitation(orgSlug);

  function submit(event: FormEvent) {
    event.preventDefault();
    const uses = maxUses.trim() ? Number(maxUses) : null;
    create.mutate(
      { role, expiresInDays: Number(days), maxUses: uses },
      {
        onSuccess: (invitation) => {
          toast.success(`Created ${invitation.code}`);
          setMaxUses("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-2">
        <Label>Role</Label>
        <Select
          value={role}
          onValueChange={(value: InvitationDto["role"]) => setRole(value)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {isOwner && <SelectItem value="admin">Admin</SelectItem>}
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="guest">Guest</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Expires in</Label>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 day</SelectItem>
            <SelectItem value="7">7 days</SelectItem>
            <SelectItem value="30">30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="max-uses">Max uses</Label>
        <Input
          id="max-uses"
          type="number"
          min={1}
          max={1000}
          placeholder="Unlimited"
          className="w-32"
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={create.isPending}>
        <PlusIcon />
        Create code
      </Button>
    </form>
  );
}

const statusLabel: Record<InvitationDto["status"], string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  used_up: "Used up",
};

function InvitationRow({
  orgSlug,
  invitation,
}: {
  orgSlug: string;
  invitation: InvitationDto;
}) {
  const revoke = useRevokeInvitation(orgSlug);
  const active = invitation.status === "active";

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2">
      <code
        className={
          active
            ? "font-mono font-medium"
            : "font-mono text-muted-foreground line-through"
        }
      >
        {invitation.code}
      </code>
      <Badge variant="secondary" className="capitalize">
        {invitation.role}
      </Badge>
      <Badge variant={active ? "outline" : "ghost"}>
        {statusLabel[invitation.status]}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {invitation.useCount} / {invitation.maxUses ?? "∞"} uses
      </span>
      <span className="text-xs text-muted-foreground">
        {active ? "Expires" : "Expired"}{" "}
        {dateFormat.format(new Date(invitation.expiresAt))}
      </span>
      {active && (
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy code"
            onClick={() => copy(invitation.code, "code")}
          >
            <CopyIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy join link"
            onClick={() =>
              copy(
                `${window.location.origin}/?join=${encodeURIComponent(invitation.code)}`,
                "join link",
              )
            }
          >
            <LinkIcon />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(invitation.id, {
                onSuccess: () => toast.success(`Revoked ${invitation.code}`),
                onError: (err) => toast.error(err.message),
              })
            }
          >
            Revoke
          </Button>
        </div>
      )}
    </li>
  );
}
