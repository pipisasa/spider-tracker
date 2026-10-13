import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inviteInstructions } from "../../../web/app/src/lib/agent-invite-instructions";
import { run } from "./cli";

// The web invite page and the plugin's create-agent command both tell an AI assistant to run
// `spider accept-invite`; keep them in line with the CLI and safe to paste into a shell (ST-34).

async function acceptInviteHelp(): Promise<string> {
  let out = "";
  const write = (s: string) => (out += s);
  await run(["accept-invite", "--help"], {
    env: {},
    stdout: { write },
    stderr: { write },
  });
  return out;
}

function acceptInviteLine(text: string): string {
  const line = text
    .split("\n")
    .find((l) => l.trim().startsWith("spider accept-invite "));
  if (!line) throw new Error("no `spider accept-invite` line");
  return line.trim();
}

const sources = {
  "web invite instructions": inviteInstructions({
    code: "ABCD-EFGH",
    link: "https://tracker.test/agent-invite/ABCD-EFGH",
    origin: "https://tracker.test",
  }),
  "plugin create-agent command": readFileSync(
    join(
      import.meta.dir,
      "../../../plugins/spider-tracker/commands/create-agent.md",
    ),
    "utf8",
  ),
};

describe("accept-invite instructions", () => {
  for (const [name, text] of Object.entries(sources)) {
    test(`${name}: flags exist and values are single-quoted`, async () => {
      const line = acceptInviteLine(text);
      const help = await acceptInviteHelp();
      const flags = line.match(/--[a-z][a-z-]*/g) ?? [];
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags)
        expect(help).toMatch(new RegExp(`\\s${flag}\\b`));

      expect(line).not.toContain('"');
      expect(line).toMatch(/^spider accept-invite '[^']+' /);
      for (const flag of ["--name", "--handle", "--description", "--prompt"]) {
        expect(line).toMatch(new RegExp(`\\s${flag} '[^']+'(\\s|$)`));
      }
    });
  }

  test("both explain how to quote a single quote", () => {
    for (const text of Object.values(sources))
      expect(text).toContain(`--name 'Don'\\''s bot'`);
  });
});
