import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// How `spider claude` starts Claude Code: the argument list, the permission mode it starts in, and
// a check for hooks in the user's Claude Code settings that would fail at startup.

type Env = Record<string, string | undefined>;

/** Claude Code's `--permission-mode` choices (`default` is the older name of `manual`). */
export const PERMISSION_MODES = [
  "auto",
  "manual",
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** What `spider claude` passes when neither the command line nor the saved agent names a mode. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export const isPermissionMode = (value: string): value is PermissionMode =>
  (PERMISSION_MODES as readonly string[]).includes(value);

/** Where the session's permission mode comes from, for the startup line. */
export type PermissionSource = "option" | "claude-args" | "agent" | "default";

export interface PermissionChoice {
  /** null when the claude arguments decide it (`--dangerously-skip-permissions`). */
  mode: string | null;
  source: PermissionSource;
}

/** The message for a saved permission mode Claude Code doesn't know (ST-125: fail closed). */
export const invalidSavedModeMessage = (agent: string, value: string) =>
  `The permission mode saved for ${agent} ("${value}") isn't one Claude Code knows (${PERMISSION_MODES.join(", ")}). Set it with spider agents permission-mode ${agent} <mode>, or remove it with spider agents permission-mode ${agent} --clear`;

/** A saved permission mode that would decide the session isn't valid: nothing starts. */
export class InvalidSavedModeError extends Error {
  constructor(readonly value: string) {
    super(`Invalid saved permission mode "${value}"`);
    this.name = "InvalidSavedModeError";
  }
}

/**
 * The value after `flag` in args, or in `flag=value` form; `null` when the flag is there without a
 * value (the last word, or `flag=`), which callers refuse (ST-125).
 */
export function flagValue(
  args: string[],
  flag: string,
): string | null | undefined {
  for (const [i, arg] of args.entries()) {
    if (arg === flag) return args[i + 1] ?? null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
  }
  return undefined;
}

/**
 * The mode a session starts in: `spider claude --permission-mode`, else one in the arguments for
 * claude, else the saved agent's, else auto. Always explicit, so Claude Code's own default (settings,
 * built-in, its version) never decides it. A saved mode Claude Code doesn't know, when it would
 * decide, throws InvalidSavedModeError: it fails closed (ST-125), since a typo of a stricter mode
 * must never start in auto. The store itself keeps any string.
 */
export function permissionModeFor(
  option: string | undefined,
  claudeArgs: string[],
  saved: string | undefined,
): PermissionChoice {
  if (option) return { mode: option, source: "option" };
  if (claudeArgs.includes("--dangerously-skip-permissions"))
    return { mode: null, source: "claude-args" };
  const passed = flagValue(claudeArgs, "--permission-mode");
  if (passed) return { mode: passed, source: "claude-args" };
  if (saved !== undefined) {
    if (!isPermissionMode(saved)) throw new InvalidSavedModeError(saved);
    return { mode: saved, source: "agent" };
  }
  return { mode: DEFAULT_PERMISSION_MODE, source: "default" };
}

export interface LaunchPlan {
  /** Arguments for claude given after `--`. */
  claudeArgs: string[];
  /** The Claude Code agent (`--agent`), unless claudeArgs already name one. */
  agent?: string;
  /** The temporary MCP config file. */
  mcpConfig: string;
  channel: boolean;
  permission: PermissionChoice;
}

/** The `claude …` command line `spider claude` runs. */
export function claudeCommand(plan: LaunchPlan): string[] {
  const { permission } = plan;
  const addMode =
    permission.mode !== null && permission.source !== "claude-args";
  return [
    "claude",
    ...plan.claudeArgs,
    ...(addMode && permission.mode
      ? ["--permission-mode", permission.mode]
      : []),
    ...(plan.agent ? ["--agent", plan.agent] : []),
    // Both options take several values, so they come last.
    "--mcp-config",
    plan.mcpConfig,
    ...(plan.channel
      ? ["--dangerously-load-development-channels", "server:spider-channel"]
      : []),
  ];
}

const SOURCE_LABEL: Record<PermissionSource, string> = {
  option: "--permission-mode",
  "claude-args": "claude arguments",
  agent: "saved for this agent",
  default: "spider default",
};

/** The startup line about the permission mode. */
export const permissionLine = ({ mode, source }: PermissionChoice) =>
  mode === null
    ? "Permission mode: bypassPermissions (--dangerously-skip-permissions)"
    : `Permission mode: ${mode} (${SOURCE_LABEL[source]})`;

/** Claude Code's settings files that apply in `cwd`: the user's, then the project's. */
export function claudeSettingsFiles(
  env: Env,
  cwd: string | undefined,
): string[] {
  const userDir =
    env.CLAUDE_CONFIG_DIR?.trim() || (env.HOME && join(env.HOME, ".claude"));
  return [
    ...(userDir ? [join(userDir, "settings.json")] : []),
    ...(cwd
      ? [
          join(cwd, ".claude", "settings.json"),
          join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every command hook in a settings object, with its event. */
function commandHooks(settings: unknown): { event: string; command: string }[] {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return [];
  const found: { event: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isRecord(hook) && typeof hook.command === "string")
          found.push({ event, command: hook.command });
      }
    }
  }
  return found;
}

const SCRIPT = /\.(?:c?js|mjs|ts|sh|py)$/;

/** A word of a hook command, as a shell splits it, and how it starts. */
interface HookWord {
  /** The word with its quotes removed (adjacent quoted and unquoted parts joined). */
  text: string;
  /** The quote its first character was in: null when it starts unquoted. */
  startQuote: '"' | "'" | null;
  /** Its first part (before any quote changes), with how it was quoted. */
  head: string;
}

/**
 * Splits a hook command into words as a POSIX shell does (ST-125): quotes don't end a word, so
 * `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` is one word; a backslash escapes the next character
 * outside single quotes. Operators (`&&`, `;`, `|`) count as words when spaced, which is enough here.
 */
function hookWords(command: string): HookWord[] {
  const words: HookWord[] = [];
  let quote: '"' | "'" | null = null;
  let current: HookWord | null = null;
  let inHead = true;
  const add = (char: string) => {
    current ??= { text: "", startQuote: quote, head: "" };
    current.text += char;
    if (inHead) current.head += char;
  };
  const end = () => {
    if (current) words.push(current);
    current = null;
    inHead = true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") {
        quote = null;
        inHead = false;
      } else add(char);
    } else if (quote === '"') {
      if (char === '"') {
        quote = null;
        inHead = false;
      } else if (char === "\\" && /["\\$`]/.test(command[i + 1] ?? ""))
        add(command[++i]!);
      else add(char);
    } else if (/\s/.test(char)) end();
    else if (char === "'" || char === '"') {
      if (current) inHead = false;
      else current = { text: "", startQuote: char, head: "" };
      quote = char;
    } else if (char === "\\" && i + 1 < command.length) add(command[++i]!);
    else add(char);
  }
  end();
  return words;
}

const HOME_PREFIX = /^(?:\$HOME|\$\{HOME\})(?=\/)/;

/**
 * Script files a hook command runs by path (`node "/x/hook.js"`, `~/hooks/a.sh`), expanded as the
 * shell does: `~` only when the word starts unquoted, `$HOME` / `${HOME}` when it starts unquoted or
 * in double quotes, nothing in single quotes. Other variables aren't expanded, so such words
 * (`"$CLAUDE_PROJECT_DIR"/…`) aren't checked.
 */
export function hookScripts(command: string, env: Env): string[] {
  const home = env.HOME;
  return hookWords(command)
    .map(({ text, startQuote }) => {
      if (!home || startQuote === "'") return text;
      const tilde = startQuote === null ? text.replace(/^~(?=\/)/, home) : text;
      return tilde.replace(HOME_PREFIX, home);
    })
    .filter((w) => isAbsolute(w) && SCRIPT.test(w));
}

/** Scripts named as a quoted `~/…`: the shell doesn't expand `~` in quotes, so they name no file. */
export const quotedTildeWords = (command: string): string[] =>
  hookWords(command)
    .filter(
      (w) =>
        w.startQuote !== null && w.text.startsWith("~/") && SCRIPT.test(w.text),
    )
    .map((w) => w.text);

/**
 * A hook that will fail: its script is `missing`, or it names a script as a quoted `~/…`
 * (`quotedTilde`), which the shell leaves unexpanded (ST-125).
 */
export type BrokenHook = {
  settings: string;
  event: string;
  command: string;
} & ({ missing: string } | { quotedTilde: string });

/**
 * Hooks in Claude Code's settings whose script is gone. Claude Code runs them anyway and shows a
 * hook error at every start (a missing `node` script fails in `node:internal/modules/cjs/loader`).
 */
export async function brokenHooks(
  env: Env,
  cwd: string | undefined,
): Promise<BrokenHook[]> {
  const broken: BrokenHook[] = [];
  for (const settings of claudeSettingsFiles(env, cwd)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(settings, "utf8"));
    } catch {
      continue;
    }
    for (const { event, command } of commandHooks(parsed)) {
      for (const word of quotedTildeWords(command))
        broken.push({ settings, event, command, quotedTilde: word });
      for (const script of hookScripts(command, env)) {
        const exists = await access(script).then(
          () => true,
          () => false,
        );
        if (!exists) broken.push({ settings, event, command, missing: script });
      }
    }
  }
  return broken;
}
