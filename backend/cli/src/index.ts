#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { run, type Choice } from "./cli";

/** Best effort: open a URL in the default browser. */
function openUrl(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** A numbered list on stderr, grouped; reads the number from the terminal. */
async function select(question: string, choices: Choice[]): Promise<string | null> {
  const lines = [question];
  let group: string | undefined;
  choices.forEach((choice, i) => {
    if (choice.group && choice.group !== group) {
      group = choice.group;
      lines.push(`  ${group}`);
    }
    lines.push(`    ${String(i + 1).padStart(2)}) ${choice.label}${choice.hint ? `  (${choice.hint})` : ""}`);
  });
  process.stderr.write(`${lines.join("\n")}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question(`Pick 1-${choices.length} [1]: `)).trim();
      if (answer === "q") return null;
      const picked = choices[answer === "" ? 0 : Number(answer) - 1];
      if (picked && /^\d*$/.test(answer)) return picked.value;
    }
  } catch {
    return null;
  } finally {
    rl.close();
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
