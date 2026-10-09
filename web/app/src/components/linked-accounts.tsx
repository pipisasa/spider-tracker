import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { authProvidersQuery } from "@/lib/queries";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

// Sign-in methods a user can attach to their account after signing in.
const linkable = [
  { id: "batele-id", label: "Batele ID" },
  { id: "github", label: "GitHub" },
] as const;

export function LinkedAccounts({ linkError }: { linkError?: string }) {
  const { data: providers } = useQuery(authProvidersQuery);
  const { data: accounts } = useQuery({
    queryKey: ["linked-accounts"],
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error(error.message ?? "Could not load linked accounts");
      return data;
    },
  });
  const [error, setError] = useState<string | null>(linkError ? authErrorMessage(linkError) : null);

  const available = linkable.filter((p) => providers?.providers.includes(p.id));
  if (available.length === 0) return null;

  async function link(provider: (typeof linkable)[number]["id"]) {
    setError(null);
    const here = `${window.location.origin}/account`;
    const { error } = await authClient.linkSocial({ provider, callbackURL: here, errorCallbackURL: here });
    if (error) setError(error.message ?? "Could not link this account");
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Sign-in methods</h2>
      <ul className="divide-y rounded-lg border">
        {available.map((p) => {
          const linked = accounts?.some((a) => a.providerId === p.id);
          return (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <span className="font-medium">{p.label}</span>
              {linked ? (
                <span className="text-sm text-muted-foreground">Linked</span>
              ) : (
                <Button variant="outline" size="sm" onClick={() => link(p.id)} disabled={!accounts}>
                  Link {p.label}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
