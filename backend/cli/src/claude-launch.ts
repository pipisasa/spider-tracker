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

/** A character of a hook word: quoted or backslash-escaped characters are literal to the shell. */
interface WordChar {
  char: string;
  quote: '"' | "'" | null;
  escaped: boolean;
}

/**
 * Splits a hook command into words as a POSIX shell does (ST-125), keeping how each character was
 * quoted: quotes don't end a word, so `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` is one word; a
 * backslash escapes the next character outside single quotes (in double quotes only `"`, `\`, `$`
 * and a backtick). Operators (`&&`, `;`, `|`) count as words when spaced, which is enough here.
 */
function hookWords(command: string): WordChar[][] {
  const words: WordChar[][] = [];
  let quote: '"' | "'" | null = null;
  let current: WordChar[] | null = null;
  const add = (char: string, escaped = false) => {
    current ??= [];
    current.push({ char, quote, escaped });
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else add(char);
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && /["\\$`]/.test(command[i + 1] ?? ""))
        add(command[++i]!, true);
      else add(char);
    } else if (/\s/.test(char)) {
      if (current) words.push(current);
      current = null;
    } else if (char === "'" || char === '"') {
      current ??= [];
      quote = char;
    } else if (char === "\\" && i + 1 < command.length)
      add(command[++i]!, true);
    else add(char);
  }
  if (current) words.push(current);
  return words;
}

const textOf = (word: WordChar[]) => word.map((c) => c.char).join("");

/** `~/` at the start, both characters unquoted and unescaped: the only `~` a shell expands. */
const expandsTilde = (word: WordChar[]) =>
  word.length >= 2 &&
  word[0]!.char === "~" &&
  word[1]!.char === "/" &&
  word.slice(0, 2).every((c) => c.quote === null && !c.escaped);

const HOME_PREFIX = /^(?:\$HOME|\$\{HOME\})(?=\/)/;

/** `$HOME/` or `${HOME}/` at the start, none of it single-quoted or escaped. */
function homePrefixLength(word: WordChar[]): number {
  const match = HOME_PREFIX.exec(textOf(word));
  if (!match) return 0;
  const prefix = word.slice(0, match[0].length);
  return prefix.every((c) => c.quote !== "'" && !c.escaped)
    ? match[0].length
    : 0;
}

/**
 * Script files a hook command runs by path (`node "/x/hook.js"`, `~/hooks/a.sh`), expanded as the
 * shell does: `~/` only unquoted and unescaped, `$HOME` / `${HOME}` unquoted or in double quotes
 * and unescaped; `\~/a.sh`, `~"/a.sh"`, `'~/a.sh'` and `\$HOME/a.sh` stay literal. Other variables
 * aren't expanded, so such words (`"$CLAUDE_PROJECT_DIR"/…`) aren't checked.
 */
export function hookScripts(command: string, env: Env): string[] {
  const home = env.HOME;
  return hookWords(command)
    .map((word) => {
      const text = textOf(word);
      if (!home) return text;
      if (expandsTilde(word)) return `${home}${text.slice(1)}`;
      const length = homePrefixLength(word);
      return length ? `${home}${text.slice(length)}` : text;
    })
    .filter((w) => isAbsolute(w) && SCRIPT.test(w));
}

/**
 * Scripts named as `~/…` with the `~` or its `/` quoted or escaped: the shell leaves them as is,
 * so they name no file.
 */
export const quotedTildeWords = (command: string): string[] =>
  hookWords(command)
    .filter((word) => {
      const text = textOf(word);
      return text.startsWith("~/") && SCRIPT.test(text) && !expandsTilde(word);
    })
    .map(textOf);

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
