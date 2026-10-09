#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { run } from "./cli";

/** Best effort: open a URL in the default browser. */
function openUrl(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  // Only open a browser for a person at a terminal.
  openUrl: process.stdout.isTTY ? openUrl : undefined,
});
