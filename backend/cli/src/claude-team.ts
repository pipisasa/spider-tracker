import { findAgent, listAgents, type AgentEntry, type Store } from "./credentials";
import { usageError } from "./resolve";
import { isSessionName, type TmuxPlan } from "./tmux";

// Which saved agents `spider claude … --tmux` starts, and the `spider claude <agent>` command each window runs.

export interface TeamSelection {
  /** Agents named on the command line (handle, org/handle or server/org/handle). */
  names: string[];
  /** Every saved agent (narrowed by `project` and `server`). */
  all: boolean;
  /** Only saved agents whose scope names this project key. */
  project?: string;
  /** Only saved agents on this server (its saved name). */
  server?: string;
}

/** True when a saved agent's scope names `key`; unscoped agents (all projects) don't count as a project's agents. */
export const inProject = (entry: AgentEntry, key: string) =>
  entry.saved.projects?.some((p) => p.key.toUpperCase() === key.trim().toUpperCase()) ?? false;

/**
 * The agents to start, deduplicated: the named ones, or with `all` every saved agent, narrowed to the
 * project and server. Window names are handles, so two agents with one handle are a usage error.
 */
export function teamAgents(store: Store, selection: TeamSelection): AgentEntry[] {
  const { names, all, project, server } = selection;
  if (all && names.length) throw usageError("Name agents or use --all, not both");
  if (project && !all) throw usageError("--project goes with --all: spider claude --all --project <key> --tmux <session>");
  let agents: AgentEntry[];
  if (all) {
    agents = listAgents(store)
      .filter((a) => (server === undefined || a.server === server) && (project === undefined || inProject(a, project)))
      .sort((a, b) => a.agent.localeCompare(b.agent) || a.ref.localeCompare(b.ref));
    if (!agents.length) {
      const where = [project && `scoped to project ${project.toUpperCase()}`, server && `on server ${server}`].filter(Boolean).join(" ");
      throw usageError(
        `No saved agents${where ? ` ${where}` : ""}. Saved agents: ${listAgents(store).map((a) => a.ref).join(", ") || "none"}`,
      );
    }
  } else {
    const seen = new Set<string>();
    agents = names.map((name) => findAgent(store, name)).filter((a) => !seen.has(a.ref) && seen.add(a.ref));
  }
  const byHandle = new Map<string, string[]>();
  for (const a of agents) byHandle.set(a.agent, [...(byHandle.get(a.agent) ?? []), a.ref]);
  const clashes = [...byHandle.values()].filter((refs) => refs.length > 1);
  if (clashes.length) {
    throw usageError(
      `Windows are named by handle, and these share one: ${clashes.map((refs) => refs.join(" and ")).join("; ")}. Narrow it with --server or name the agents`,
    );
  }
  return agents;
}

export interface WindowOptions {
  channel: boolean;
  permissionMode?: string;
  /** Arguments for claude, given after `--`. */
  claudeArgs: string[];
}

/** The `spider claude <agent> …` command a window runs, with the options passed through. */
export function windowArgv(self: string[], entry: AgentEntry, opts: WindowOptions): string[] {
  return [
    ...self,
    "claude",
    entry.ref,
    ...(opts.channel ? [] : ["--no-channel"]),
    ...(opts.permissionMode ? ["--permission-mode", opts.permissionMode] : []),
    ...(opts.claudeArgs.length ? ["--", ...opts.claudeArgs] : []),
  ];
}

export function checkSession(session: string) {
  if (!isSessionName(session)) throw usageError(`Invalid tmux session name "${session}": no spaces, ":" or "."`);
}

/** The plan as text: one line per agent, with the command for windows that will start. */
export function planLines(plan: TmuxPlan, dryRun: boolean, windowCommand: (argv: string[]) => string): string[] {
  const width = Math.max(...plan.windows.map((w) => w.window.length));
  const head = dryRun
    ? `Plan for tmux session ${plan.session}${plan.exists ? "" : " (would be created)"}:`
    : `tmux session ${plan.session}${plan.exists ? "" : " (created)"}:`;
  const lines = [head];
  for (const w of plan.windows) {
    const name = w.window.padEnd(width);
    if (!w.start) lines.push(`  skip   ${name}  already running (window exists)`);
    else lines.push(dryRun ? `  start  ${name}  ${windowCommand(w.argv)}` : `  start  ${name}  ${w.agent}`);
  }
  const started = plan.windows.filter((w) => w.start).length;
  const running = plan.windows.length - started;
  const summary = `${dryRun ? "Would start" : "Started"} ${started} of ${plan.windows.length}${running ? `, ${running} already running` : ""}.`;
  lines.push(dryRun ? summary : `${summary} Attach: tmux attach -t ${plan.session}`);
  return lines;
}
