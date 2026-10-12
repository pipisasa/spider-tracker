import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { DeviceRequestDto } from "@repo/core/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, TerminalIcon, XCircleIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

// Approval page for `spider login` (RFC 8628 verification URI).
export const Route = createFileRoute("/_authed/device")({
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" ? { code: search.code } : {},
  component: DevicePage,
});

function DevicePage() {
  const { code } = Route.useSearch();
  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-md">{code ? <Decide code={code} /> : <EnterCode />}</Card>
    </main>
  );
}

function EnterCode() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) void navigate({ to: "/device", search: { code: value.trim().toUpperCase() } });
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Connect a device</CardTitle>
        <CardDescription>Enter the code shown by `spider login` in your terminal.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Label htmlFor="device-code">Code</Label>
          <Input
            id="device-code"
            autoFocus
            placeholder="WDJB-MJHT"
            className="font-mono tracking-widest uppercase"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" disabled={!value.trim()}>
            Continue
          </Button>
        </form>
      </CardContent>
    </>
  );
}

function Decide({ code }: { code: string }) {
  const { me } = Route.useRouteContext();
  // The device becomes an agent member; guests can't create agents.
  const memberships = me.memberships.filter((m) => m.actor.role !== "guest");
  const [orgSlug, setOrgSlug] = useState(memberships[0]?.organization.slug ?? "");
  const [done, setDone] = useState<"approved" | "denied" | null>(null);

  const request = useQuery({
    queryKey: ["device", code],
    queryFn: () => api<DeviceRequestDto>(`/v1/device/${encodeURIComponent(code)}`),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api<void>(`/v1/device/${encodeURIComponent(code)}/${approve ? "approve" : "deny"}`, {
        method: "POST",
        body: JSON.stringify(approve ? { orgSlug } : {}),
      }),
    onSuccess: (_data, approve) => setDone(approve ? "approved" : "denied"),
  });

  if (done) {
    return (
      <CardHeader className="items-center text-center">
        {done === "approved" ? (
          <CheckCircle2Icon className="size-10 text-green-600 dark:text-green-500" />
        ) : (
          <XCircleIcon className="size-10 text-muted-foreground" />
        )}
        <CardTitle>{done === "approved" ? "Device connected" : "Request denied"}</CardTitle>
        <CardDescription>You can close this tab and return to your terminal.</CardDescription>
      </CardHeader>
    );
  }

  if (request.isPending) return <CardHeader>Loading…</CardHeader>;
  if (request.isError || !request.data) {
    return (
      <CardHeader>
        <CardTitle>Code not found</CardTitle>
        <CardDescription>{request.error?.message ?? "Check the code in your terminal and try again."}</CardDescription>
      </CardHeader>
    );
  }

  const device = request.data;
  const expired = new Date(device.expiresAt) <= new Date();
  if (device.status !== "pending" || expired) {
    return (
      <CardHeader>
        <CardTitle>This code can't be used</CardTitle>
        <CardDescription>
          {expired ? "It has expired." : "It has already been used."} Run <code>spider login</code> again for a new one.
        </CardDescription>
      </CardHeader>
    );
  }

  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalIcon className="size-5" />
          Connect “{device.clientName}”?
        </CardTitle>
        <CardDescription>
          Confirm that your terminal shows <strong className="font-mono">{device.userCode}</strong>. The device gets its
          own agent member with an API key, acting with at most your role. You can revoke it under Settings → Agents.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {memberships.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Guests can't connect devices. Ask an owner or admin to change your role.
          </p>
        )}
        {memberships.length > 1 && (
          <div className="flex flex-col gap-2">
            <Label>Organization</Label>
            <Select value={orgSlug} onValueChange={setOrgSlug}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {memberships.map(({ organization }) => (
                  <SelectItem key={organization.id} value={organization.slug}>
                    {organization.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {decide.isError && <p className="text-sm text-destructive">{decide.error.message}</p>}
        <div className="flex gap-2">
          {memberships.length > 0 && (
            <Button className="flex-1" disabled={decide.isPending || !orgSlug} onClick={() => decide.mutate(true)}>
              Approve
            </Button>
          )}
          <Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            Deny
          </Button>
        </div>
      </CardContent>
    </>
  );
}
