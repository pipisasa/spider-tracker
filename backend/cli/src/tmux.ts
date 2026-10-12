// `spider claude … --tmux <session>`: one tmux window per agent, each running `spider claude <agent> …`,
// so per-agent startup (permission mode, channel, hook warnings) stays in the single-agent command.

export interface TmuxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `tmux <args>`; injected in tests so they never start a real tmux server. */
export type TmuxRunner = (args: string[]) => TmuxResult;

export const runTmux: TmuxRunner = (args) => {
  try {
    const result = Bun.spawnSync({ cmd: ["tmux", ...args], stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch {
    // tmux is not installed.
    return { exitCode: 127, stdout: "", stderr: "tmux not found" };
  }
};

/** Quotes a word for a POSIX shell command line (tmux runs window commands through the user's shell). */
export const shellQuote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/**
 * tmux treats `:` and `.` in a target as window and pane separators, so a session name can't hold them;
 * a leading `=` (exact match), `$` (session id) or `%` (pane id) would change what the target means.
 */
export const isSessionName = (name: string) => /^[^\s:.=$%][^\s:.]*$/.test(name);

export const TMUX_MISSING =
  "tmux isn't installed (or not on PATH). Install it (macOS: brew install tmux; Debian/Ubuntu: sudo apt install tmux) and run this again";

/** tmux's version line, or null when tmux can't run. */
export function tmuxVersion(tmux: TmuxRunner): string | null {
  const result = tmux(["-V"]);
  return result.exitCode === 0 ? result.stdout.trim() || "tmux" : null;
}

// `=name` matches the session exactly; a bare name would also match a session it is a prefix of.
const exact = (session: string) => `=${session}`;

/** Window names in `session`, or null when there is no such session. */
export function windowNames(session: string, tmux: TmuxRunner): string[] | null {
  if (tmux(["has-session", "-t", exact(session)]).exitCode !== 0) return null;
  const result = tmux(["list-windows", "-t", exact(session), "-F", "#{window_name}"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `tmux list-windows -t ${session} failed`);
  return result.stdout.split("\n").filter(Boolean);
}

export interface WindowLaunch {
  /** The window name: the agent's handle. */
  window: string;
  /** The saved agent's full ref. */
  agent: string;
  /** The command the window runs, as argv. */
  argv: string[];
  /** false when a window with this name is already in the session: the agent runs, so it isn't started again. */
  start: boolean;
}

export interface TmuxPlan {
  session: string;
  /** The session exists already. */
  exists: boolean;
  windows: WindowLaunch[];
}

/** Which windows to open: one per agent, skipping names already in the session. */
export function tmuxPlan(
  session: string,
  existing: string[] | null,
  agents: { window: string; agent: string; argv: string[] }[],
): TmuxPlan {
  const taken = new Set(existing ?? []);
  return {
    session,
    exists: existing !== null,
    windows: agents.map((a) => ({ ...a, start: !taken.has(a.window) })),
  };
}

/** The shell command line a window runs. */
export const windowCommand = (argv: string[]) => argv.map(shellQuote).join(" ");

/**
 * Opens the plan's windows (detached): the session with the first new window if it doesn't exist,
 * then a window per agent. Each starts in `cwd` with `env` set (tmux 3.0+ `-e`). Throws with tmux's
 * message when a command fails; windows opened before it stay, and a rerun skips them.
 */
export function openWindows(plan: TmuxPlan, cwd: string, env: Record<string, string>, tmux: TmuxRunner): void {
  let exists = plan.exists;
  const envArgs = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  for (const w of plan.windows.filter((x) => x.start)) {
    const args = exists
      ? ["new-window", "-d", "-t", `${exact(plan.session)}:`, "-n", w.window, "-c", cwd, ...envArgs, windowCommand(w.argv)]
      : ["new-session", "-d", "-s", plan.session, "-n", w.window, "-c", cwd, ...envArgs, windowCommand(w.argv)];
    const result = tmux(args);
    if (result.exitCode !== 0) {
      throw new Error(`tmux ${args[0]} for ${w.window} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    exists = true;
  }
}
