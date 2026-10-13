import { LinkedAccounts } from "@/components/linked-accounts";
import { Button } from "@/components/ui/button";
import { useSignOut } from "@/lib/use-sign-out";
import { meQuery } from "@/lib/queries";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/account")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  component: AccountPage,
});

function AccountPage() {
  const { data: me } = useSuspenseQuery(meQuery);
  const { error: linkError } = Route.useSearch();

  const signOut = useSignOut();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Account</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{me?.user.email}</span>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Your organizations
        </h2>
        <ul className="divide-y rounded-lg border">
          {me?.memberships.map(({ organization, actor }) => (
            <li
              key={organization.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <Link
                to="/$orgSlug"
                params={{ orgSlug: organization.slug }}
                className="font-medium hover:underline"
              >
                {organization.name}
              </Link>
              <span className="text-sm text-muted-foreground">
                @{actor.handle} · {actor.role}
              </span>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="self-start" asChild>
          <Link to="/onboarding">New organization</Link>
        </Button>
      </section>
      <LinkedAccounts linkError={linkError} />
    </main>
  );
}
