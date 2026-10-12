#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { styleText } from "node:util";
import { Separator, select as inquirerSelect } from "@inquirer/prompts";
import { run, type Choice } from "./cli";

/** Best effort: open a URL in the default browser. */
function openUrl(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** Arrow-key menu on stderr: ↑/↓ move, Enter picks, Esc or Ctrl-C cancels. Groups become dividers. */
async function select(question: string, choices: Choice[]): Promise<string | null> {
  const items: (Separator | { value: string; name: string; description?: string })[] = [];
  let group: string | undefined;
  for (const choice of choices) {
    if (choice.group && choice.group !== group) {
      group = choice.group;
      items.push(new Separator(styleText("dim", `── ${group}`)));
    }
    items.push({
      value: choice.value,
      name: choice.hint ? `${choice.label}  ${styleText("dim", choice.hint)}` : choice.label,
    });
  }
  const controller = new AbortController();
  const onKey = (_: unknown, key?: { name?: string }) => {
    if (key?.name === "escape") controller.abort();
  };
  process.stdin.on("keypress", onKey);
  try {
    return await inquirerSelect(
      { message: question, choices: items, pageSize: 12, loop: false },
      { output: process.stderr, signal: controller.signal, clearPromptOnDone: false },
    );
  } catch {
    // ExitPromptError (Ctrl-C) or AbortPromptError (Esc).
    return null;
  } finally {
    process.stdin.off("keypress", onKey);
  }
}

/** Runs a program attached to this terminal; resolves to its exit code. */
async function spawnInherit(argv: string[], options: { env: Record<string, string | undefined> }) {
  const child = Bun.spawn(argv, { env: options.env, stdio: ["inherit", "inherit", "inherit"] });
  // Ctrl-C reaches the child through the terminal; don't die before it does.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", ignore);
  }
}

const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  // Only open a browser for a person at a terminal.
  openUrl: process.stdout.isTTY ? openUrl : undefined,
  stdin: () => Bun.stdin.text(),
  select: interactive ? select : undefined,
  spawn: spawnInherit,
});
