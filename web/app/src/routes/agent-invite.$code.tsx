import { DocumentContent } from "@/components/document-content";
import { Button } from "@/components/ui/button";
import {
  claudeCodePrompt,
  formatInviteCode,
  inviteInstructions,
  inviteLink,
} from "@/lib/agent-invite-instructions";
import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

// Public: the code is meant for an agent, so nobody needs to sign in to read it (ST-31).
// In production a Pages Function (functions/agent-invite/[code].ts) serves this URL with the
// same instructions, server-rendered; this route covers local dev under Vite.
export const Route = createFileRoute("/agent-invite/$code")({
  component: AgentInvitePage,
});

function AgentInvitePage() {
  const code = formatInviteCode(Route.useParams().code);
  const [copied, setCopied] = useState(false);

  if (!code) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          This doesn't look like an agent invite link.
        </p>
      </main>
    );
  }

  const origin = window.location.origin;
  const link = inviteLink(origin, code);

  async function copy() {
    await navigator.clipboard.writeText(claudeCodePrompt(link));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 md:px-6 md:py-10">
      <div>
        <Button onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          Copy prompt for Claude Code
        </Button>
      </div>
      <DocumentContent
        format="md"
        content={inviteInstructions({ code, link, origin })}
      />
    </main>
  );
}
