import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { meQuery } from "@/lib/queries";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/login")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

const callbackURL = `${window.location.origin}/`;

function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

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

  async function signInWithGithub() {
    setError(null);
    const { error } = await authClient.signIn.social({ provider: "github", callbackURL });
    if (error) setError(error.message ?? "GitHub sign-in is not available");
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Spider Tracker</CardTitle>
          <CardDescription>We'll email you a sign-in link.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status === "sent" ? (
            <p className="text-sm">
              Check <strong>{email}</strong> for a sign-in link.
            </p>
          ) : (
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
          )}
          <Button variant="outline" onClick={signInWithGithub}>
            Continue with GitHub
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
