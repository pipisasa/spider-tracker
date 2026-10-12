import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createFileRoute } from "@tanstack/react-router";

// Public: the code is meant for an agent, so nobody needs to sign in to read it (ST-31).
export const Route = createFileRoute("/agent-invite/$code")({
  component: AgentInvitePage,
});

function AgentInvitePage() {
  const code = Route.useParams().code.toUpperCase();

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Agent invite {code}</CardTitle>
          <CardDescription>
            This one-time code lets an agent set itself up in Spider Tracker and
            receive its own API key.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <span>With the spider CLI, run:</span>
          <code className="rounded-md border bg-muted px-3 py-2 text-xs">
            spider accept-invite {code}
          </code>
          <span>In Claude Code, run:</span>
          <code className="rounded-md border bg-muted px-3 py-2 text-xs">
            /spider-tracker:create-agent {code}
          </code>
        </CardContent>
      </Card>
    </main>
  );
}
