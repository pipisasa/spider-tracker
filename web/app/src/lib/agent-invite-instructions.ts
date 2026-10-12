// Shared by the SPA invite page and the Pages Function in functions/agent-invite/[code].ts,
// which serves the same text to fetchers that don't run JavaScript (ST-34). Keep it free of
// browser and Vite APIs.

const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/** Returns the code as `ABCD-EFGH`, or null if it isn't shaped like an invite code. */
export function formatInviteCode(raw: string): string | null {
  const compact = raw.replaceAll("-", "").toUpperCase();
  if (!CODE_PATTERN.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export const inviteLink = (origin: string, code: string) =>
  `${origin}/agent-invite/${code}`;

export const claudeCodePrompt = (link: string) =>
  `Set up my Spider Tracker agent: ${link}`;

/** Setup instructions for an agent invite, as Markdown. `code` must come from formatInviteCode. */
export function inviteInstructions({
  code,
  link,
  origin,
}: {
  code: string;
  link: string;
  origin: string;
}): string {
  return `# Spider Tracker agent invite ${code}

You were invited to set up an AI agent for Spider Tracker. The agent becomes a member of the inviter's organization with its own API key and sees only the projects the inviter picked.

The code works **once** and expires. Opening this page does not use it up.

The easiest way: paste this into Claude Code on the machine where the agent will run:

\`\`\`
${claudeCodePrompt(link)}
\`\`\`

## Instructions for the AI assistant

If you are an AI coding assistant (e.g. Claude Code) and the user asked you to set this up, follow these steps, showing the user each command before running it:

1. **Check for the spider CLI.** Run \`spider --version\`. If the command is missing, install it:

   \`\`\`sh
   curl -fsSL ${origin}/install.sh | sh
   \`\`\`

   The script downloads the \`spider\` binary for this OS and CPU from the project's GitHub releases (github.com/pipisasa/spider-tracker) into \`~/.local/bin\`. If \`~/.local/bin\` is not on \`PATH\`, add it (for example \`export PATH="$HOME/.local/bin:$PATH"\` in the shell profile) or call \`~/.local/bin/spider\` directly. Run \`spider --version\` again to confirm.

2. **Install the Claude Code plugin.** Run \`spider setup claude\`.

3. **Ask the user** what this agent should do and what to call it. Suggest a short name and a lowercase handle (letters, digits and dashes), for example "Release Bot" / \`release-bot\`. From the answer, write a one-line description and a role prompt that tells the agent what it is responsible for.

4. **Accept the invite** with the full invite link:

   \`\`\`sh
   spider accept-invite ${link} --name "<name>" --description "<one line>" --prompt "<role prompt>" --handle <handle> --json
   \`\`\`

   This saves the agent's API key and writes its Claude Code agent.

   - If it reports an invalid or expired code, stop and tell the user to ask the inviter for a new invite.
   - If the handle is taken (409 conflict), suggest another handle and run the command again with it.

5. **Tell the user how to start the agent:** \`spider claude <handle>\`. People can mention it in the tracker as \`@<handle>\`.

Never print, copy or store the API key that the CLI saves; it stays in the CLI's credentials file.
`;
}
