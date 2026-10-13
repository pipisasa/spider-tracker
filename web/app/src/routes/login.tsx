import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { authProvidersQuery, meQuery } from "@/lib/queries";
import type { AuthProvider } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/login")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { error?: string; redirect?: string } => ({
    ...(typeof search.error === "string" ? { error: search.error } : {}),
    // Only same-app paths, so the login page can't be used to send people elsewhere.
    ...(typeof search.redirect === "string" &&
    search.redirect.startsWith("/") &&
    !search.redirect.startsWith("//")
      ? { redirect: search.redirect }
      : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me) throw redirect({ href: search.redirect ?? "/" });
  },
  loader: ({ context }) =>
    context.queryClient.prefetchQuery(authProvidersQuery),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const callbackURL = `${window.location.origin}${search.redirect ?? "/"}`;
  const errorCallbackURL = `${window.location.origin}/login${search.redirect ? `?redirect=${encodeURIComponent(search.redirect)}` : ""}`;
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const { error: errorCode } = search;
  const [error, setError] = useState<string | null>(
    errorCode ? authErrorMessage(errorCode) : null,
  );

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    setStatus("sending");
    setError(null);
    const { error } = await authClient.signIn.magicLink({ email, callbackURL });
    if (error) {
      setStatus("idle");
      setError(error.message ?? "Could not send the link");
      return;
    }
    setStatus("sent");
  }

  const { data } = useQuery(authProvidersQuery);
  const providers = data?.providers ?? [];
  // Email links are offered only when no other sign-in method is configured.
  const showEmail = providers.includes("magic-link") && providers.length === 1;

  async function signInWith(
    provider: Extract<AuthProvider, "github" | "batele-id">,
  ) {
    setError(null);
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL,
      errorCallbackURL,
    });
    if (error)
      setError(error.message ?? "This sign-in method is not available");
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Spider Tracker</CardTitle>
          {showEmail && (
            <CardDescription>We'll email you a sign-in link.</CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status === "sent" ? (
            <p className="text-sm">
              Check <strong>{email}</strong> for a sign-in link.
            </p>
          ) : (
            showEmail && (
              <form onSubmit={sendLink} className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={status === "sending"}>
                  {status === "sending" ? "Sending…" : "Email me a link"}
                </Button>
              </form>
            )
          )}
          {providers.includes("batele-id") && (
            <Button variant="outline" onClick={() => signInWith("batele-id")}>
              Continue with Batele ID
            </Button>
          )}
          {providers.includes("github") && (
            <Button variant="outline" onClick={() => signInWith("github")}>
              Continue with GitHub
            </Button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
