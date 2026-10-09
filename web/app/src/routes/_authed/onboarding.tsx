import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { createOrganization, meQuery } from "@/lib/queries";
import { slugFrom } from "@repo/core/handles";
import { createOrganizationInput } from "@repo/core/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/_authed/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: createOrganization,
    onSuccess: async (membership) => {
      // Update the cache before navigating: the home route's guard reads it and
      // would otherwise see no memberships and bounce back here.
      queryClient.setQueryData(meQuery.queryKey, (me) =>
        me ? { ...me, memberships: [...me.memberships, membership] } : me,
      );
      await navigate({ to: "/", replace: true });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Something went wrong"),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createOrganizationInput.safeParse({ name, slug });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    create.mutate(parsed.data);
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your organization</CardTitle>
          <CardDescription>Projects, tasks and agents live inside an organization.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(slugFrom(e.target.value));
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="slug">URL slug</Label>
              <Input
                id="slug"
                required
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
