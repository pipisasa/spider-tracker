import type {
  ActorDto,
  BulkTaskResultDto,
  BulkUpdateTasksResponse,
  DocumentFormat,
  DocumentSummaryDto,
  ProjectDetailDto,
  ProjectDto,
  TagDto,
  TaskDto,
  WhoAmIResponse,
} from "@repo/core/contracts";
import { INBOX_KINDS, isOverdue, normalizeHandle, parseTaskKey } from "@repo/core/schemas";
import { formatUnifiedDiff } from "@repo/core/diff";
import { MIN_CLI_HEADER } from "@repo/core/version";
import {
  actorHandle,
  commentView,
  documentDiffView,
  documentVersionView,
  projectRulesView,
  relationView,
  taskView,
  type RelationView,
  type TaskView,
} from "@repo/core/views";
import type {
  BulkUpdateTasksInput,
  CreateTaskInput,
  DocumentEdit,
  UpdateDocumentInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@repo/core/schemas";
import { SpiderApiError, createClient, type FetchLike } from "@repo/sdk";
import { Command, CommanderError, Option } from "commander";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  defaultAgent,
  findAgent,
  isServer,
  listAgents,
  putAgent,
  readStore,
  removeAgent,
  resolveServer,
  serverForLink,
  writeStore,
  type AgentEntry,
  type Store,
} from "./credentials";
import { PLUGIN_ID, agentFileRefreshes, claudeAgentFor, refreshAgentFiles, linkedClaudeAgents, pluginRoot, removeClaudeAgents, scanClaudeAgents, writeClaudeAgent } from "./claude-agents";
import {
  ClaudeCommandError,
  INSTALL_CLAUDE_HINT,
  SHARED_MARKETPLACE,
  SHARED_PLUGIN_ID,
  installAgentsPlugin,
  installSharedPlugin,
  marketplaceSource,
  writeProjectSettings,
  type RunClaude,
} from "./claude-setup";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  brokenHooks,
  claudeCommand,
  isPermissionMode,
  permissionLine,
  permissionModeFor,
  type PermissionMode,
} from "./claude-launch";
import { branchNameFor, taskKeysIn } from "@repo/core/git";
import { createOrSwitchBranch, currentBranch, isDirty, isRepo, runGit, taskKeyFromBranch, type GitRunner } from "./git";
import { isCompiled } from "./self-update";
import { checkSession, planLines, teamAgents, windowArgv } from "./claude-team";
import { TMUX_MISSING, openWindows, runTmux, shellQuote, tmuxPlan, tmuxVersion, windowCommand, windowNames, type TmuxRunner } from "./tmux";
import { describePlan, runUninstall, uninstallPlan } from "./uninstall";
import { checkForUpdates } from "./update-check";
import {
  hookNote,
  hookOutput,
  installedPluginVersion,
  noticeAllowed,
  passiveNoticeFor,
  startNotice,
  updateReport,
  type UpdateReport,
} from "./update";
import { CLI_VERSION, isNewer } from "./version";
import {
  CliError,
  EXIT,
  PRIORITY_NAMES,
  firstStatus,
  fromApiError,
  matchStatuses,
  parseDate,
  parseLimit,
  parseVersion,
  matchesTaskFilter,
  mineActorIds,
  parsePriority,
  parseRelationKind,
  resolveAssignees,
  resolveTags,
  resolveStatus,
  usageError,
} from "./resolve";

export { EXIT, type ExitCode } from "./resolve";

export const DEFAULT_API_URL = "https://tracker-api.batele.plus";
const VERSION = CLI_VERSION;

export interface Writer {
  write(chunk: string): unknown;
}

export interface RunOptions {
  /** SPIDER_TOKEN, SPIDER_API_URL, SPIDER_CONFIG_DIR, HOME. */
  env: Record<string, string | undefined>;
  /** Override the transport, e.g. to call the Hono app in tests. */
  fetch?: FetchLike;
  stdout: Writer;
  stderr: Writer;
  /** Where to look for the git branch when a task key is omitted. */
  cwd?: string;
  /** Opens the login page in a browser (`spider login`); omitted in tests. */
  openUrl?: (url: string) => void;
  /** Waits between device-login polls; overridable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Reads standard input, for `--file -`. */
  stdin?: () => Promise<string>;
  /** Asks a person to pick one of `choices` (only at an interactive terminal); null when cancelled. */
  select?: (question: string, choices: Choice[]) => Promise<string | null>;
  /** Runs a program with inherited stdio and resolves to its exit code (`spider claude`). */
  spawn?: (argv: string[], options: { env: Record<string, string | undefined> }) => Promise<number>;
  /** Runs `git <args>` in a directory (branch lookups, `spider start`); defaults to the real git. */
  git?: GitRunner;
  /** Runs `tmux <args>` (`spider claude --tmux`); defaults to the real tmux. */
  tmux?: TmuxRunner;
  /** The command that runs this CLI, for the MCP config `spider claude` writes; defaults to the running one. */
  self?: string[];
  /** Runs `claude <args>` capturing its output (plugin setup); undefined result when Claude Code is missing. */
  runClaude?: RunClaude;
  /** Transport for update checks and downloads (GitHub); defaults to the global fetch. */
  httpFetch?: FetchLike;
  /** stderr is a terminal: allows the passive "a new spider is available" notice. */
  isInteractive?: boolean;
  /** Replaces this compiled binary with release `version` and resolves to its path; omitted when running from source. */
  selfUpdate?: (version: string) => Promise<string | undefined>;
  /** Asks a person yes/no (only at an interactive terminal); `spider uninstall` without --yes. */
  confirm?: (question: string) => Promise<boolean>;
  /** The installed spider binary `spider uninstall` deletes; omitted when running from source. */
  binaryPath?: string;
}

export interface Choice {
  value: string;
  label: string;
  /** Choices are shown under their group, e.g. "prod › batele". */
  group?: string;
  hint?: string;
}

/** `spider claude` options. */
interface ClaudeOptions {
  channel: boolean;
  permissionMode?: PermissionMode;
  tmux?: string;
  all?: boolean;
  project?: string;
  dryRun?: boolean;
}

/** Program-wide options. */
interface Globals {
  as?: string;
  server?: string;
}

/** How to run this CLI again: the compiled binary, or bun with this checkout's entry point. */
export function selfInvocation(): string[] {
  return isCompiled() ? [process.execPath] : [process.execPath, join(import.meta.dir, "index.ts")];
}

/** A task as the CLI prints it with --json (the same shape MCP returns, ST-107). */
export type CliTask = TaskView;

interface JsonOption {
  json?: boolean;
}

type DocEditOptions = JsonOption & {
  title?: string;
  format?: string;
  file?: string;
  baseVersion?: string;
  force?: boolean;
  old?: string;
  new?: string;
  all?: boolean;
  append?: boolean;
  section?: string;
  text?: string;
};

interface TaskFields extends JsonOption {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assign?: string[];
  tag?: string[];
  parent?: string;
  start?: string;
  target?: string;
}

/** The changes `task update` makes, as typed (before resolving names to ids). */
interface TaskChanges {
  status?: string;
  priority?: string;
  assign?: string[];
  tag?: string[];
  parent?: string;
  start?: string;
  target?: string;
}

/**
 * `task update` options. With --project (filter mode) --status, --parent, --tag and --priority
 * select tasks and only the --set-* flags change them; otherwise both forms set the field.
 */
interface TaskUpdateOptions extends TaskFields {
  setStatus?: string;
  setPriority?: string;
  setAssign?: string[];
  setTag?: string[];
  setParent?: string;
  setStart?: string;
  setTarget?: string;
  overdue?: boolean;
  project?: string;
  assignee?: string[];
  anyTag?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

interface TaskListOptions extends JsonOption {
  project?: string;
  status?: string;
  mine?: boolean;
  assignee?: string[];
  tag?: string[];
  anyTag?: boolean;
  priority?: string[];
  overdue?: boolean;
  limit: string;
}

/** Repeatable, comma-separable --assign. */
const collect = (value: string, previous: string[] | undefined) => [
  ...(previous ?? []),
  ...value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
];

/** API access for one invocation, with per-run caches of the org, members and projects. */
/** "MacBook-Pro.local" → "MacBook-Pro". */
function defaultDeviceName() {
  return hostname().replace(/\.local$/, "").slice(0, 60) || "CLI";
}

const apiUrlOf = (env: RunOptions["env"]) => env.SPIDER_API_URL?.trim() || DEFAULT_API_URL;

interface Credentials {
  token: string;
  baseUrl: string;
  /** The saved agent in use; undefined for SPIDER_TOKEN. */
  entry?: AgentEntry;
  /** Why this saved agent: chosen with --as, named by SPIDER_AGENT, or the default agent. */
  via?: string;
}

/** Which key a command uses: --as, then SPIDER_TOKEN, then SPIDER_AGENT, then the default saved agent. */
async function credentialsFor(options: RunOptions, globals: Globals): Promise<Credentials> {
  const store = await readStore(options.env);
  const saved = (entry: AgentEntry, via: string) => ({ token: entry.saved.token, baseUrl: entry.serverUrl, entry, via });
  if (globals.as) return saved(findAgent(store, globals.as), "chosen with --as");
  const token = options.env.SPIDER_TOKEN?.trim();
  if (token) return { token, baseUrl: apiUrlOf(options.env) };
  const named = options.env.SPIDER_AGENT?.trim();
  if (named) return saved(findAgent(store, named), "named by SPIDER_AGENT");
  const fallback = defaultAgent(store);
  if (fallback) return saved(fallback, "the default agent");
  const message = listAgents(store).length
    ? `No default agent. Pass --as <agent> or run \`spider agents default <agent>\` (${agentList(store)})`
    : "Not signed in. Run `spider accept-invite <code>` or `spider login`, or set SPIDER_TOKEN to an agent API key";
  throw new CliError(EXIT.auth, message, "unauthorized");
}

/**
 * The key credentialsFor would pick, only if it belongs to `nameOrUrl` (mcp-headers --server):
 * undefined when it is another server's, so a key never goes to the wrong server.
 */
async function credentialsOn(options: RunOptions, globals: Globals, nameOrUrl: string): Promise<Credentials | undefined> {
  const store = await readStore(options.env);
  const target = resolveServer(store, nameOrUrl);
  const on = (entry: AgentEntry | undefined) =>
    entry && isServer(target, entry.server, entry.serverUrl) ? { token: entry.saved.token, baseUrl: entry.serverUrl, entry } : undefined;
  if (globals.as) return on(findAgent(store, globals.as));
  const token = options.env.SPIDER_TOKEN?.trim();
  if (token) {
    const baseUrl = apiUrlOf(options.env);
    const { key, server } = resolveServer(store, baseUrl);
    return isServer(target, key, server.url) ? { token, baseUrl } : undefined;
  }
  const named = options.env.SPIDER_AGENT?.trim();
  return on(named ? findAgent(store, named) : defaultAgent(store));
}

const agentList = (store: Store) => listAgents(store).map((a) => a.ref).join(", ");

/** The saved agent a local-only command (logout, claude) means: --as, SPIDER_AGENT, else the default. */
function savedAgentFor(store: Store, options: RunOptions, globals: Globals) {
  const named = globals.as ?? options.env.SPIDER_AGENT?.trim();
  return named ? findAgent(store, named) : defaultAgent(store);
}

/** null: all projects (unscoped, or unknown); []: a scoped agent whose projects are all gone. */
const scopeOf = (entry: AgentEntry) => {
  const { projects } = entry.saved;
  if (!projects) return "all projects";
  return projects.length ? projects.map((p) => p.key).join(", ") : "no projects";
};

/** The MCP config `spider claude` passes to Claude Code: no secrets, the key comes from mcp-headers. */
export function claudeMcpConfig(entry: AgentEntry, self: string[], channel: boolean) {
  const [command = "spider", ...args] = self;
  return {
    mcpServers: {
      spider: {
        type: "http",
        url: `${entry.serverUrl}/mcp`,
        headersHelper: [...self, "mcp-headers", "--as", entry.ref, "--server", entry.server].map(shellQuote).join(" "),
      },
      ...(channel
        ? { "spider-channel": { type: "stdio", command, args: [...args, "channel", "--as", entry.ref] } }
        : {}),
    },
  };
}

function connect(options: RunOptions, globals: Globals, apiFetch: FetchLike) {
  const credentials = credentialsFor(options, globals);
  credentials.catch(() => {});
  const ready = credentials.then(({ token, baseUrl }) =>
    createClient({ baseUrl, token, source: "cli", fetch: apiFetch }),
  );
  // Commands await `sdk()`; this only stops an early failure from being reported as unhandled.
  ready.catch(() => {});
  const sdk = () => ready;

  let who: Promise<WhoAmIResponse> | undefined;
  let members: Promise<ActorDto[]> | undefined;
  let actors: Promise<ActorDto[]> | undefined;
  let tagList: Promise<TagDto[]> | undefined;
  const projects = new Map<string, Promise<ProjectDetailDto>>();

  const whoami = () => (who ??= ready.then((c) => c.whoami()));
  const org = async () => (await whoami()).organization.slug;
  const loadTags = () => (tagList ??= org().then(async (slug) => (await sdk()).tags.list(slug).then((r) => r.items)));
  const loadMembers = () => (members ??= org().then(async (slug) => (await sdk()).members.list(slug).then((r) => r.items)));
  // Deactivated actors too, for naming assignees and authors; `members` is for resolving handles.
  const loadActors = () =>
    (actors ??= org().then(async (slug) => (await sdk()).members.list(slug, { all: true }).then((r) => r.items)));
  const project = (key: string) => {
    const upper = key.toUpperCase();
    let cached = projects.get(upper);
    if (!cached) {
      cached = org().then(async (slug) => (await sdk()).projects.get(slug, upper));
      projects.set(upper, cached);
    }
    return cached;
  };

  /** Adds the status, assignee handles and tag names, for printing (`taskView`, shared with MCP). */
  const describe = async (task: TaskDto): Promise<CliTask> => {
    const [detail, actors, tags] = await Promise.all([
      project(projectKeyOf(task.key)),
      loadActors(),
      task.tagIds?.length ? loadTags() : [],
    ]);
    return taskView(task, { statuses: detail.statuses, actors, tags });
  };

  return { sdk, credentials, whoami, org, members: loadMembers, actors: loadActors, tags: loadTags, project, describe };
}

type Api = ReturnType<typeof connect>;

const projectKeyOf = (taskKey: string) => parseTaskKey(taskKey)?.projectKey ?? taskKey.split("-")[0] ?? taskKey;

/** The task key given, or the one in the current branch name. */
function taskKey(given: string | undefined, cwd: string, git: GitRunner): string {
  if (given) {
    const parsed = parseTaskKey(given.trim());
    if (!parsed) throw usageError(`Invalid task key "${given}". Expected something like ST-12`);
    return `${parsed.projectKey}-${parsed.number}`;
  }
  const branch = currentBranch(cwd, git);
  const key = branch ? taskKeyFromBranch(branch) : null;
  if (!key) {
    throw usageError(
      branch
        ? `No task key given and none found in branch "${branch}"`
        : "No task key given and no git branch to take it from",
    );
  }
  return key;
}

// Human-readable output: one line per item, short enough for an agent's context window.

const assigneeList = (task: CliTask) => task.assignees.map((h) => `@${h}`).join(" ");

function taskLines(tasks: CliTask[]): string {
  const keyWidth = Math.max(0, ...tasks.map((t) => t.key.length));
  const statusWidth = Math.max(0, ...tasks.map((t) => (t.status?.name ?? "").length));
  return tasks
    .map((t) =>
      [
        t.key.padEnd(keyWidth),
        (t.status?.name ?? "?").padEnd(statusWidth),
        t.priority ? `P${t.priority}` : "  ",
        t.title,
        t.targetDate ? `due ${t.targetDate}${isOverdue(t, t.status?.category) ? " (overdue)" : ""}` : "",
        t.tags.map((name) => `#${name}`).join(" "),
        assigneeList(t),
      ]
        .filter((part, i) => i < 4 || part)
        .join("  "),
    )
    .join("\n");
}

function taskDetail(task: CliTask): string {
  const lines = [
    `${task.key}  ${task.title}`,
    `Status: ${task.status?.name ?? "?"} · Priority: ${PRIORITY_NAMES[task.priority]} · Assignees: ${assigneeList(task) || "none"}${task.tags.length ? ` · Tags: ${task.tags.join(", ")}` : ""}`,
    `Created ${task.createdAt} · Updated ${task.updatedAt}${task.completedAt ? ` · Completed ${task.completedAt}` : ""}`,
  ];
  if (task.startDate || task.targetDate) {
    const overdue = isOverdue(task, task.status?.category) ? " (overdue)" : "";
    lines.push([task.startDate && `Start: ${task.startDate}`, task.targetDate && `Target: ${task.targetDate}${overdue}`].filter(Boolean).join(" · "));
  }
  if (task.parentKey) lines.push(`Parent: ${task.parentKey}`);
  if (task.description) lines.push("", task.description);
  return lines.join("\n");
}

/** One line per task of a bulk update, then the counts (and how to apply, after a preview). */
function bulkLines(
  dryRun: boolean,
  results: (Omit<BulkTaskResultDto, "task"> & { task: CliTask | null })[],
  summary: BulkUpdateTasksResponse["summary"],
  applyHint?: string,
): string {
  if (results.length === 0) return "No matching tasks";
  const label = (outcome: BulkTaskResultDto["outcome"]) =>
    outcome === "changed" ? (dryRun ? "would change" : "changed") : outcome === "unchanged" ? "unchanged" : "failed";
  const keyWidth = Math.max(...results.map((r) => r.key.length));
  const labelWidth = Math.max(...results.map((r) => label(r.outcome).length));
  const lines = results.map((r) =>
    [
      r.key.padEnd(keyWidth),
      label(r.outcome).padEnd(labelWidth),
      r.task ? `${r.task.status?.name ?? "?"}  ${r.task.title}` : (r.error?.message ?? ""),
    ].join("  "),
  );
  const counts = `${summary.changed} ${dryRun ? "would change" : "changed"}, ${summary.unchanged} unchanged, ${summary.failed} failed`;
  lines.push(dryRun ? `Dry run: ${counts}; nothing was changed.${applyHint ? ` ${applyHint}` : ""}` : counts);
  return lines.join("\n");
}

const projectLine = (p: ProjectDto) => `${p.key}  ${p.name}${p.archivedAt ? "  (archived)" : ""}`;

const documentScope = (d: DocumentSummaryDto) => d.taskKey ?? d.projectKey ?? "org";

function documentLines(docs: DocumentSummaryDto[]): string {
  const scopeWidth = Math.max(0, ...docs.map((d) => documentScope(d).length));
  return docs.map((d) => `${d.id}  ${documentScope(d).padEnd(scopeWidth)}  v${d.version}  ${d.title}`).join("\n");
}

function parseFormat(value: string): DocumentFormat {
  const format = value.trim().toLowerCase();
  if (format === "md" || format === "markdown") return "md";
  if (format === "html") return "html";
  throw usageError(`Invalid format "${value}". Use md or html`);
}

/** newVersion from `claude plugin update --json` (its last line). */
function updatedVersion(output: string): string | undefined {
  const last = output.trim().split("\n").pop() ?? "";
  try {
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed === "object" && parsed !== null && "newVersion" in parsed && typeof parsed.newVersion === "string") {
      return parsed.newVersion;
    }
  } catch {
    // Not JSON: an older Claude Code.
  }
  return undefined;
}

/** `spider update --check` for people. */
function reportLines(report: UpdateReport): string {
  const { cli, plugin } = report;
  const lines = [
    `spider        ${cli.current}${cli.latest ? (cli.outdated ? ` → ${cli.latest} available` : " (latest)") : " (latest unknown)"}`,
    `${plugin.id}  ${
      plugin.installed === null
        ? `not installed${plugin.latest ? ` (latest ${plugin.latest})` : ""}`
        : `${plugin.installed}${plugin.latest ? (plugin.outdated ? ` → ${plugin.latest} available` : " (latest)") : " (latest unknown)"}`
    }`,
  ];
  const outdated = report.agents.filter((a) => a.state === "outdated");
  const unmanaged = report.agents.filter((a) => a.state === "unmanaged");
  lines.push(
    report.agents.length
      ? `agent files   ${outdated.length ? `${outdated.length} of ${report.agents.length} need refreshing` : `${report.agents.length} up to date`}`
      : "agent files   none",
  );
  for (const a of outdated) lines.push(`  ${a.path} (${a.version ? `v${a.version}` : "before version markers"})`);
  for (const a of unmanaged) lines.push(`  ${a.path} (no generated section; left as is)`);
  if (cli.outdated || plugin.outdated || outdated.length) lines.push("Run: spider update");
  return lines.join("\n");
}

/** Builds the command tree for one run; actions write to the run's streams. */
function buildProgram(options: RunOptions, cwd: string, argv: string[], json = false) {
  const { stdout, stderr } = options;
  const git = options.git ?? runGit;
  let api: Api | undefined;
  /** Set by commands that run another program (`spider claude`) to its exit code. */
  const result: { exitCode?: number } = {};
  const globals = () => program.opts<Globals>();
  const conn = () => (api ??= connect(options, globals(), apiFetch));
  const httpFetch: FetchLike = options.httpFetch ?? ((input, init) => fetch(input, init));
  // Warns once per run when the server says this CLI is older than it supports.
  let warnedMinCli = false;
  const apiFetch: FetchLike = async (input, init) => {
    const res = await (options.fetch ?? fetch)(input, init);
    const min = res.headers.get(MIN_CLI_HEADER);
    if (!warnedMinCli && min && isNewer(min, VERSION)) {
      warnedMinCli = true;
      stderr.write(
        `This spider (${VERSION}) is older than the server supports (${min}); some commands may fail. Run: spider update\n`,
      );
    }
    return res;
  };
  const print = (text: string) => stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
  const output = (opts: JsonOption, json: unknown, human: () => string) =>
    print(opts.json ? JSON.stringify(json) : human());

  const program = new Command("spider")
    .description("Spider Tracker from the terminal. Auth: SPIDER_TOKEN (agent API key)")
    .version(VERSION)
    .option("--as <agent>", "act as this saved agent: handle, org/handle or server/org/handle")
    .option("--server <name|url>", "server for login, accept-invite and mcp-headers: prod, local, a saved name or an API URL")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => stdout.write(s),
      writeErr: (s) => stderr.write(s),
      // With --json, run() reports parse errors as JSON instead.
      outputError: (s, write) => {
        if (!json) write(s);
      },
    })
    .showHelpAfterError(json ? false : "(run with --help for usage)");

  const withJson = (cmd: Command) => cmd.option("--json", "print stable JSON");

  /** Builds the API input for create/update from the shared task options. */
  const taskInput = async (projectKey: string, opts: TaskFields) => {
    const input: UpdateTaskInput = {};
    if (opts.title !== undefined) input.title = opts.title;
    if (opts.description !== undefined) input.description = opts.description === "" ? null : opts.description;
    if (opts.priority !== undefined) input.priority = parsePriority(opts.priority);
    if (opts.status !== undefined) input.statusId = resolveStatus(await conn().project(projectKey), opts.status).id;
    if (opts.assign !== undefined) {
      const { actor } = await conn().whoami();
      input.assigneeIds = resolveAssignees(await conn().members(), actor.id, opts.assign);
    }
    if (opts.tag !== undefined) input.tagIds = resolveTags(await conn().tags(), opts.tag);
    if (opts.parent !== undefined) {
      const { sdk, org } = conn();
      input.parentId = opts.parent.trim() === "" ? null : (await (await sdk()).tasks.get(await org(), taskKey(opts.parent, cwd, git))).id;
    }
    if (opts.start !== undefined) input.startDate = parseDate(opts.start, "--start");
    if (opts.target !== undefined) input.targetDate = parseDate(opts.target, "--target");
    return input;
  };

  const taskOptions = (cmd: Command) =>
    withJson(
      cmd
        .option("--description <text>", "description (Markdown)")
        .option("--status <name>", "status name or category, e.g. \"In Progress\" or in_progress")
        .option("--priority <0-4>", "0 none, 1 urgent, 2 high, 3 medium, 4 low")
        .option("--assign <handle>", "assignee handle or \"me\"; repeatable or comma-separated", collect)
        .option("--tag <name>", "tag name; repeatable or comma-separated (replaces the tags on update)", collect)
        .option("--parent <key>", 'parent task key, making this a sub-task ("" makes it top-level)')
        .option("--start <date>", 'start date, YYYY-MM-DD ("" clears it)')
        .option("--target <date>", 'target date, YYYY-MM-DD, on or after the start ("" clears it)'),
    );

  /** Updates a task and prints the result. */
  const update = async (key: string, input: UpdateTaskInput, opts: JsonOption) => {
    const { sdk, org, describe } = conn();
    const task = await describe(await (await sdk()).tasks.update(await org(), key, input));
    output(opts, task, () => taskLines([task]));
  };

  withJson(program.command("whoami").description("show the agent and organization the token acts as")).action(
    async (opts: JsonOption) => {
      const who = await conn().whoami();
      const { entry } = await conn().credentials;
      output(
        opts,
        { ...who, agent: entry?.ref ?? null },
        () =>
          `@${who.actor.handle} (${who.actor.name}, ${who.actor.role}) in ${who.organization.slug}${entry ? ` · saved agent ${entry.ref}` : ""}`,
      );
    },
  );

  /** The server login and accept-invite talk to: --server, SPIDER_API_URL, else prod. */
  const serverFor = (store: Store) => resolveServer(store, globals().server ?? (options.env.SPIDER_API_URL?.trim() || "prod"));

  /** Makes sure Claude Code knows the private agents plugin; a note for the user when it couldn't. */
  const ensureAgentsPlugin = async (): Promise<string | undefined> => {
    const root = pluginRoot(options.env);
    if (!root) return undefined;
    try {
      if (options.runClaude && (await installAgentsPlugin(options.runClaude, root))) return undefined;
      return `${INSTALL_CLAUDE_HINT}\nThe agent file is written; then run spider setup claude to install the ${PLUGIN_ID} plugin.`;
    } catch (error) {
      if (error instanceof ClaudeCommandError) return `Couldn't install the ${PLUGIN_ID} plugin: ${error.message}`;
      throw error;
    }
  };

  withJson(
    program
      .command("accept-invite")
      .description("set up an agent from an invitation code; saves its key on this machine")
      .argument("<code>", "the code (ABCD-EFGH) or the invite link")
      .option("--name <name>", "what to call the agent")
      .option("--handle <handle>", "its @handle (default: from the name)")
      .option("--description <text>", "what it does")
      .option("--prompt <text>", "its role: the system prompt of its Claude Code agent (default: from name and description)")
      .option("--no-claude", "don't write a Claude Code agent for it")
      .option("--default", "make it the default agent"),
  ).action(
    async (
      code: string,
      opts: JsonOption & { name?: string; handle?: string; description?: string; prompt?: string; claude: boolean; default?: boolean },
    ) => {
      const store = await readStore(options.env);
      // An invite link names its server; a bare code goes to --server / SPIDER_API_URL / prod.
      const link = /^https?:\/\//i.test(code.trim());
      const linked = !globals().server && link ? serverForLink(store, code) : undefined;
      if (link && !globals().server && !linked) {
        throw usageError(
          `The invite link points at ${URL.parse(code.trim())?.origin ?? "a server"}, which spider doesn't know. Pass --server with its API URL (or prod, local, a saved server name)`,
        );
      }
      const { key, server } = linked ?? serverFor(store);
      const client = createClient({ baseUrl: server.url, source: "cli", fetch: apiFetch });
      const accepted = await client.agentInvites.accept({
        code,
        name: opts.name,
        handle: opts.handle,
        description: opts.description,
      });
      const { actor, organization, projects, owner } = accepted;
      const previous = defaultAgent(store);
      const isDefault = opts.default || !previous;
      const ref = putAgent(store, key, server, organization, {
        token: accepted.token,
        actor: { id: actor.id, name: actor.name, handle: actor.handle },
        projects,
        source: "invite",
        createdAt: new Date().toISOString(),
      });
      // Keep an implicit default (the only agent so far) once there are two.
      store.default = isDefault ? { server: key, org: organization.slug, agent: actor.handle } : previous && { server: previous.server, org: previous.org, agent: previous.agent };
      await writeStore(options.env, store);
      // Its Claude Code agent goes into the private spider-agents plugin.
      const claudeAgent = opts.claude
        ? await writeClaudeAgent(options.env, findAgent(store, ref), {
            description: opts.description?.trim() || `${actor.name}, Spider Tracker agent @${actor.handle} in ${organization.name}`,
            prompt:
              opts.prompt?.trim() ||
              `You are ${actor.name}${opts.description?.trim() ? `: ${opts.description.trim()}` : ""}. Work on the Spider Tracker tasks assigned to you or that mention you, keep them updated, and hand off finished work for review.`,
            projects,
          })
        : undefined;
      const note = claudeAgent ? await ensureAgentsPlugin() : undefined;
      if (note && opts.json) stderr.write(`${note}\n`);
      output(opts, { agent: ref, actor, organization, projects, owner, claudeAgent: claudeAgent ?? null }, () =>
        [
          `You are @${actor.handle} (${actor.name}) in ${organization.name}.`,
          `Owner: @${owner.handle} (${owner.name}), who sent the invite and can manage this agent.`,
          `Projects: ${projects.length ? projects.map((p) => `${p.key} ${p.name}`).join(", ") : "none"}`,
          `Saved as ${ref}${isDefault ? " (default)" : ""}.`,
          ...(claudeAgent ? [`Claude Code agent: ${claudeAgent.qualifiedName} (${claudeAgent.path})`] : []),
          ...(note ? [note] : []),
          "",
          "Next:",
          `  spider claude ${actor.handle}        start Claude Code as this agent`,
          `  spider whoami --as ${actor.handle}   use it from the CLI`,
        ].join("\n"),
      );
    },
  );

  withJson(
    program
      .command("login")
      .description("sign in through the browser; saves an agent key for this device")
      .option("--name <device>", "what to call this device", defaultDeviceName())
      .option("--no-browser", "print the link instead of opening a browser"),
  ).action(async (opts: JsonOption & { name: string; browser: boolean }) => {
    const store = await readStore(options.env);
    const { key, server } = serverFor(store);
    const client = createClient({ baseUrl: server.url, fetch: apiFetch });
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const code = await client.device.start(opts.name);
    // Instructions go to stderr so stdout stays clean for --json.
    stderr.write(`Open ${code.verification_uri} and confirm the code ${code.user_code}\n`);
    if (opts.browser && options.openUrl) options.openUrl(code.verification_uri_complete);
    stderr.write("Waiting for approval…\n");

    let interval = code.interval * 1000;
    const deadline = Date.now() + code.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(interval);
      const result = await client.device.poll(code.device_code);
      if (result.ok) {
        const { token } = result;
        const { actor, organization } = token;
        const ref = putAgent(store, key, server, organization, {
          token: token.access_token,
          actor: { id: actor.id, name: actor.name, handle: actor.handle },
          projects: null,
          source: "login",
          createdAt: new Date().toISOString(),
        });
        store.default = { server: key, org: organization.slug, agent: actor.handle };
        const path = await writeStore(options.env, store);
        const summary = { agent: ref, actor, organization, credentials: path };
        output(opts, summary, () => `Signed in as @${actor.handle} in ${organization.slug}. Saved as ${ref} (default) in ${path}`);
        if (options.env.SPIDER_TOKEN) stderr.write("Note: SPIDER_TOKEN is set and takes precedence over the saved default agent.\n");
        return;
      }
      if (result.error === "authorization_pending") continue;
      if (result.error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (result.error === "access_denied") throw new CliError(EXIT.auth, "Login was denied in the browser", "access_denied");
      if (result.error === "expired_token") break;
      throw new CliError(EXIT.unexpected, `Device login failed (${result.error})`, result.error);
    }
    throw new CliError(EXIT.auth, "The login code expired. Run spider login again", "expired_token");
  });

  /** Revokes a saved agent's key on its server; one already revoked or deleted is fine. */
  const revoke = (entry: AgentEntry) =>
    createClient({ baseUrl: entry.serverUrl, token: entry.saved.token, source: "cli", fetch: apiFetch })
      .keys.revokeCurrent()
      .catch((err: unknown) => {
        if (!(err instanceof SpiderApiError) || (err.status !== 401 && err.status !== 404)) throw err;
      });

  withJson(program.command("logout").description("revoke and forget the saved agent in use (--as, SPIDER_AGENT or the default)")).action(
    async (opts: JsonOption) => {
      const store = await readStore(options.env);
      const entry = savedAgentFor(store, options, globals());
      if (entry) {
        await revoke(entry);
        removeAgent(store, entry);
        await writeStore(options.env, store);
      }
      output(opts, { loggedOut: !!entry, agent: entry?.ref ?? null }, () => (entry ? `Signed out @${entry.agent}` : "Not signed in"));
      if (options.env.SPIDER_TOKEN) stderr.write("SPIDER_TOKEN is still set in your environment.\n");
    },
  );

  const agents = program.command("agents").description("the agents saved on this machine");

  withJson(agents.command("list", { isDefault: true }).description("list saved agents by server and organization")).action(
    async (opts: JsonOption) => {
      const store = await readStore(options.env);
      const all = listAgents(store);
      const current = defaultAgent(store);
      const items = all.map((a) => ({
        agent: a.ref,
        server: a.server,
        serverUrl: a.serverUrl,
        org: a.org,
        orgName: a.orgName,
        handle: a.agent,
        name: a.saved.actor.name,
        projects: a.saved.projects,
        source: a.saved.source,
        createdAt: a.saved.createdAt,
        permissionMode: a.saved.permissionMode ?? null,
        default: a.ref === current?.ref,
      }));
      output(opts, { default: current?.ref ?? null, items }, () => {
        if (!all.length) return "No saved agents. Run spider accept-invite <code> or spider login";
        const lines: string[] = [];
        for (const [server, s] of Object.entries(store.servers)) {
          lines.push(`${server}  ${s.url}`);
          for (const [org, o] of Object.entries(s.orgs)) {
            lines.push(`  ${org}  ${o.name}`);
            for (const a of all.filter((x) => x.server === server && x.org === org)) {
              lines.push(`    ${a.ref === current?.ref ? "*" : " "} ${a.agent}  ${a.saved.actor.name} · ${scopeOf(a)}`);
            }
          }
        }
        return lines.join("\n");
      });
    },
  );

  withJson(agents.command("default").description("make a saved agent the default").argument("<agent>")).action(
    async (ref: string, opts: JsonOption) => {
      const store = await readStore(options.env);
      const entry = findAgent(store, ref);
      store.default = { server: entry.server, org: entry.org, agent: entry.agent };
      await writeStore(options.env, store);
      output(opts, { default: entry.ref }, () => `Default agent: ${entry.ref}`);
    },
  );

  withJson(
    agents
      .command("permission-mode")
      .description("show or set the Claude Code permission mode spider claude starts a saved agent in")
      .argument("<agent>")
      .argument("[mode]", `one of ${PERMISSION_MODES.join(", ")}`)
      .option("--clear", "go back to the spider default (auto)"),
  ).action(async (ref: string, mode: string | undefined, opts: JsonOption & { clear?: boolean }) => {
    if (mode !== undefined && !isPermissionMode(mode)) {
      throw usageError(`Unknown permission mode ${mode}. Use one of ${PERMISSION_MODES.join(", ")}`);
    }
    if (mode !== undefined && opts.clear) throw usageError("Give a mode or --clear, not both");
    const store = await readStore(options.env);
    const entry = findAgent(store, ref);
    if (mode !== undefined || opts.clear) {
      const saved = store.servers[entry.server]?.orgs[entry.org]?.agents[entry.agent];
      if (saved) {
        if (mode === undefined) delete saved.permissionMode;
        else saved.permissionMode = mode;
      }
      await writeStore(options.env, store);
    }
    const current = mode ?? (opts.clear ? undefined : entry.saved.permissionMode);
    output(opts, { agent: entry.ref, permissionMode: current ?? null, effective: current ?? DEFAULT_PERMISSION_MODE }, () =>
      current ? `${entry.ref} starts in ${current}` : `${entry.ref} starts in ${DEFAULT_PERMISSION_MODE} (the spider default)`,
    );
  });

  withJson(
    agents
      .command("remove")
      .description("forget a saved agent on this machine")
      .argument("<agent>")
      .option("--revoke", "also revoke its key on the server")
      .option("--claude", "also delete its Claude Code agent (the spider-agents plugin and ~/.claude/agents, linked by spider-agent)"),
  ).action(async (ref: string, opts: JsonOption & { revoke?: boolean; claude?: boolean }) => {
    const store = await readStore(options.env);
    const entry = findAgent(store, ref);
    if (opts.revoke) await revoke(entry);
    const deleted = opts.claude ? (await removeClaudeAgents(options.env, entry)).map((f) => f.path) : [];
    const kept = opts.claude ? [] : linkedClaudeAgents(await scanClaudeAgents(options.env), entry).map((f) => f.path);
    removeAgent(store, entry);
    await writeStore(options.env, store);
    output(opts, { removed: entry.ref, revoked: !!opts.revoke, claudeAgentsDeleted: deleted, claudeAgentsKept: kept }, () =>
      [
        opts.revoke
          ? `Removed ${entry.ref} and revoked its key`
          : `Removed ${entry.ref}. Its key still works on the server: revoke it in the web app (Settings → Agents), or next time use --revoke`,
        ...deleted.map((path) => `Deleted Claude Code agent ${path}`),
        ...(kept.length
          ? [`Its Claude Code agent is still there (delete it, or next time use --claude):`, ...kept.map((path) => `  ${path}`)]
          : []),
      ].join("\n"),
    );
  });

  /**
   * `spider claude … --tmux <session>`: a window per agent, named by handle, each running
   * `spider claude <agent>` with the same options; agents whose window exists are skipped.
   */
  const claudeInTmux = (store: Store, session: string, names: string[], claudeArgs: string[], opts: ClaudeOptions) => {
    checkSession(session);
    const server = globals().server;
    const agents = teamAgents(store, {
      names,
      all: !!opts.all,
      project: opts.project,
      server: server === undefined ? undefined : resolveServer(store, server).key,
    });
    if (!agents.length) throw usageError(`Which agents? Name them or use --all: spider claude <agent>… --tmux ${session}`);
    const tmux = options.tmux ?? runTmux;
    const installed = tmuxVersion(tmux) !== null;
    if (!installed && !opts.dryRun) throw new CliError(EXIT.unexpected, TMUX_MISSING, "tmux_missing");
    const self = options.self ?? selfInvocation();
    const plan = tmuxPlan(
      session,
      installed ? windowNames(session, tmux) : null,
      agents.map((a) => ({
        window: a.agent,
        agent: a.ref,
        argv: windowArgv(self, a, { channel: opts.channel, permissionMode: opts.permissionMode, claudeArgs }),
      })),
    );
    if (opts.dryRun) {
      if (!installed) stderr.write(`Note: ${TMUX_MISSING}\n`);
      print(planLines(plan, true, windowCommand).join("\n"));
      return;
    }
    // Windows of a running tmux server don't inherit this process's environment: pass the credentials folder on.
    const configDir = options.env.SPIDER_CONFIG_DIR?.trim();
    try {
      openWindows(plan, cwd, configDir ? { SPIDER_CONFIG_DIR: configDir } : {}, tmux);
    } catch (err) {
      throw new CliError(EXIT.unexpected, err instanceof Error ? err.message : String(err), "tmux_failed");
    }
    print(planLines(plan, false, windowCommand).join("\n"));
    if (opts.channel && plan.windows.some((w) => w.start)) {
      stderr.write(
        `Each new window waits at Claude Code's development-channels dialog: attach and press Enter in each, or see docs/agents.md for tmux send-keys\n`,
      );
    }
  };

  program
    .command("claude")
    .description("start Claude Code as a saved agent, with the spider MCP server and its inbox channel")
    .argument("[agent]", "handle, org/handle or server/org/handle (default: pick one, or the default agent)")
    .argument("[claudeArgs...]", "arguments for claude, after -- (with --tmux, more agents before --)")
    .option("--no-channel", "don't push the agent's inbox into the session")
    .addOption(
      new Option("--permission-mode <mode>", "the permission mode to start in (default: the agent's, see spider agents permission-mode, else auto)").choices(
        PERMISSION_MODES,
      ),
    )
    .option("--tmux <session>", "start each agent in its own window (named by handle) of this tmux session; running ones are skipped")
    .option("--all", "with --tmux: every saved agent (narrow with --project and --server)")
    .option("--project <key>", "with --all: only saved agents scoped to this project")
    .option("--dry-run", "with --tmux: print the launch plan, start nothing")
    .action(async (named: string | undefined, rest: string[], opts: ClaudeOptions) => {
      // Everything after "--" goes to claude; an agent is only an operand before it.
      const dash = argv.indexOf("--");
      const extra = dash >= 0 ? argv.slice(dash + 1) : rest;
      const given = (dash >= 0 && named !== undefined && 1 + rest.length <= extra.length ? undefined : named) ?? globals().as;
      // The operands before "--": with --tmux, all of them are agents.
      const operands = [...(named === undefined ? [] : [named]), ...rest].slice(0, dash >= 0 ? Math.max(0, 1 + rest.length - extra.length) : undefined);

      const store = await readStore(options.env);
      const all = listAgents(store);
      if (!all.length) {
        throw new CliError(EXIT.auth, "No saved agents. Run `spider accept-invite <code>` or `spider login` first", "unauthorized");
      }
      if (opts.permissionMode && (extra.includes("--dangerously-skip-permissions") || extra.some((a) => a === "--permission-mode" || a.startsWith("--permission-mode=")))) {
        throw usageError("Give the permission mode once: spider claude --permission-mode, or after --, not both");
      }
      if (opts.tmux !== undefined) {
        const names = operands.length ? operands : globals().as ? [globals().as ?? ""] : [];
        return claudeInTmux(store, opts.tmux, names, extra, opts);
      }
      const loose = opts.all ? "--all" : opts.project !== undefined ? "--project" : opts.dryRun ? "--dry-run" : undefined;
      if (loose) throw usageError(`${loose} goes with --tmux <session>`);
      let entry: AgentEntry | undefined;
      if (given) entry = findAgent(store, given);
      else if (options.select && all.length > 1) {
        const current = defaultAgent(store);
        const ordered = current ? [current, ...all.filter((a) => a.ref !== current.ref)] : all;
        const picked = await options.select(
          "Start Claude Code as which agent?",
          ordered.map((a) => ({
            value: a.ref,
            label: `${a.agent}  ${a.saved.actor.name}`,
            group: `${a.server} › ${a.org}`,
            hint: `${scopeOf(a)}${a.ref === current?.ref ? " · default" : ""}`,
          })),
        );
        if (!picked) throw usageError("No agent picked");
        entry = findAgent(store, picked);
      } else entry = savedAgentFor(store, options, {});
      if (!entry) throw usageError(`Which agent? Run spider claude <agent>. Saved agents: ${agentList(store)}`);
      if (!options.spawn) throw new CliError(EXIT.unexpected, "Can't start claude from here", "unexpected");

      const self = options.self ?? selfInvocation();
      const dir = await mkdtemp(join(tmpdir(), "spider-claude-"));
      const config = join(dir, "mcp.json");
      await writeFile(config, `${JSON.stringify(claudeMcpConfig(entry, self, opts.channel), null, 2)}\n`, { mode: 0o600 });
      const agentName = extra.includes("--agent") ? undefined : await claudeAgentFor(options.env, entry);
      const permission = permissionModeFor(opts.permissionMode, extra, entry.saved.permissionMode);
      const command = claudeCommand({ claudeArgs: extra, agent: agentName, mcpConfig: config, channel: opts.channel, permission });
      // The child acts as this agent: its mcp-headers and channel resolve SPIDER_AGENT, never a stray SPIDER_TOKEN.
      const env: Record<string, string | undefined> = { ...options.env, SPIDER_AGENT: entry.ref };
      delete env.SPIDER_TOKEN;
      if (noticeAllowed(argv, options.env, options.isInteractive)) await startNotice(options.env, httpFetch, (l) => stderr.write(l))();
      stderr.write(`Starting Claude Code as @${entry.agent} (${entry.ref}, ${scopeOf(entry)})${agentName ? ` with agent ${agentName}` : ""}\n`);
      stderr.write(`${permissionLine(permission)}\n`);
      if (opts.channel) {
        stderr.write(
          "Inbox channel: Claude Code asks to confirm development channels at every start (no setting skips it); choose \"I am using this for local development\", or use --no-channel\n",
        );
      }
      for (const hook of await brokenHooks(options.env, cwd)) {
        stderr.write(
          `Warning: a ${hook.event} hook in ${hook.settings} runs ${hook.missing}, which doesn't exist; Claude Code will report a hook error. Remove the hook or restore the file.\n`,
        );
      }
      try {
        result.exitCode = await options.spawn(command, { env });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

  const setup = program.command("setup").description("set up integrations on this machine");
  withJson(
    setup
      .command("claude")
      .description(`install the ${SHARED_PLUGIN_ID} Claude Code plugin (tracker skill, spider MCP server, /spider-tracker:create-agent) and the ${PLUGIN_ID} plugin for your agents`)
      .option("--project", "instead enable the plugin for this project's team in ./.claude/settings.json"),
  ).action(async (opts: JsonOption & { project?: boolean }) => {
    const source = marketplaceSource(options.env, cwd);
    if (opts.project) {
      const path = await writeProjectSettings(cwd, source).catch((error: unknown) => {
        throw error instanceof ClaudeCommandError ? usageError(error.message) : error;
      });
      output(opts, { scope: "project", settings: path, marketplace: source, plugin: SHARED_PLUGIN_ID }, () =>
        `Enabled ${SHARED_PLUGIN_ID} (from ${source}) in ${path}. Commit it; Claude Code offers the plugin to everyone who trusts this project.`,
      );
      return;
    }
    const root = pluginRoot(options.env);
    const install = async () => {
      if (!options.runClaude || !(await installSharedPlugin(options.runClaude, source))) return false;
      if (root && !(await installAgentsPlugin(options.runClaude, root))) return false;
      return true;
    };
    const installed = await install().catch((error: unknown) => {
      throw error instanceof ClaudeCommandError ? new CliError(EXIT.unexpected, error.message, "unexpected") : error;
    });
    // Without Claude Code there is nothing to install into: a note, not a failure (install scripts run this).
    if (!installed) stderr.write(`${INSTALL_CLAUDE_HINT}\nThen run spider setup claude again.\n`);
    output(
      opts,
      { scope: "user", claude: installed, marketplace: source, plugin: SHARED_PLUGIN_ID, agentsPlugin: installed && root ? PLUGIN_ID : null },
      () => (installed ? `Installed ${SHARED_PLUGIN_ID} (from ${source}) and ${PLUGIN_ID} for your user. Restart Claude Code to load them.` : ""),
    );
  });

  withJson(
    program
      .command("uninstall")
      .description("remove spider from this machine: revoke saved keys, uninstall its Claude Code plugins, delete its files")
      .option("-y, --yes", "don't ask for confirmation")
      .option("--keep-keys", "forget saved agents without revoking their keys"),
  ).action(async (opts: JsonOption & { yes?: boolean; keepKeys?: boolean }) => {
    const store = await readStore(options.env);
    const plan = await uninstallPlan(options.env, store, { keepKeys: !!opts.keepKeys, binary: options.binaryPath });
    if (!opts.yes) {
      if (!options.confirm || opts.json) {
        throw usageError(`${describePlan(plan)}\nRe-run with --yes to go ahead.`);
      }
      stderr.write(`${describePlan(plan)}\n`);
      if (!(await options.confirm("Uninstall spider?"))) {
        stderr.write("Nothing removed.\n");
        return;
      }
    }
    const removed = await runUninstall(plan, {
      revoke: (entry) => revoke(entry),
      runClaude: options.runClaude,
    });
    output(opts, removed, () =>
      [
        ...removed.revoked.map((ref) => `Revoked the key of ${ref}`),
        ...removed.revokeFailed.map(({ agent, error }) => `Couldn't revoke ${agent} (${error}); revoke it in the web app (Settings → Agents)`),
        ...removed.plugins.filter((p) => p.removed).map((p) => `Uninstalled ${p.id}`),
        ...removed.marketplaces.filter((m) => m.removed).map((m) => `Removed marketplace ${m.name}`),
        ...(removed.claudeMissing ? ["Claude Code isn't installed; no plugins to remove"] : []),
        ...removed.deleted.map((path) => `Deleted ${path}`),
        plan.binary ? "spider is uninstalled." : "Done. spider itself runs from source, so it stays.",
        "The agents themselves stay in the tracker; delete them in Settings → Agents.",
      ].join("\n"),
    );
    if (removed.revokeFailed.length) result.exitCode = EXIT.unexpected;
  });

  withJson(
    program
      .command("update")
      .description(`update spider, the ${SHARED_PLUGIN_ID} Claude Code plugin and your agent files`)
      .option("--check", "only report what is out of date")
      .option("--hook", "with --check: quiet output for a Claude Code SessionStart hook")
      // Internal: the old binary hands over to the new one after replacing itself.
      .addOption(new Option("--updated-from <version>", "skip the binary; it was just updated from <version>").hideHelp()),
  ).action(async (opts: JsonOption & { check?: boolean; hook?: boolean; updatedFrom?: string }) => {
    if (opts.hook) {
      // Runs at every session start: never fails, prints nothing unless something is out of date.
      try {
        const info = await checkForUpdates(options.env, httpFetch, { timeoutMs: 2000 });
        const report = updateReport(info, await installedPluginVersion(options.env), await agentFileRefreshes(options.env));
        const note = hookNote(report);
        if (note) print(hookOutput(note));
      } catch {
        // Nothing to report.
      }
      return;
    }
    if (opts.check) {
      const info = await checkForUpdates(options.env, httpFetch, { force: true });
      const report = updateReport(
        info,
        await installedPluginVersion(options.env, options.runClaude),
        await agentFileRefreshes(options.env),
      );
      output(opts, report, () => reportLines(report));
      return;
    }

    const lines: string[] = [];
    let failed = false;
    let restart = false;

    // The spider binary.
    let cli: { from: string; to: string | null; updated: boolean; note?: string };
    if (opts.updatedFrom) {
      cli = { from: opts.updatedFrom, to: VERSION, updated: true, note: `Updated spider ${opts.updatedFrom} → ${VERSION}` };
    } else {
      const info = await checkForUpdates(options.env, httpFetch, { force: true });
      cli = { from: VERSION, to: info.cli, updated: false };
      let replaced: string | undefined;
      if (!info.cli) cli.note = "Couldn't find the latest spider release; try again later";
      else if (!isNewer(info.cli, VERSION)) cli.note = `spider ${VERSION} is up to date`;
      else if (!options.selfUpdate) cli.note = `spider ${info.cli} is available. Running from source: update with git pull`;
      else {
        try {
          replaced = await options.selfUpdate(info.cli);
          cli.updated = true;
          cli.note = `Updated spider ${VERSION} → ${info.cli}`;
        } catch (error) {
          failed = true;
          cli.note = `Couldn't update spider: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      // The new binary finishes the job, so the agent files carry its version, not this one's.
      if (replaced && options.spawn) {
        const argv = [replaced, "update", "--updated-from", VERSION, ...(opts.json ? ["--json"] : [])];
        const code = await options.spawn(argv, { env: options.env }).catch(() => undefined);
        if (code !== undefined) {
          result.exitCode = code;
          return;
        }
      }
    }
    lines.push(cli.note ?? "");

    // The shared plugin, through Claude Code's own updater.
    const installed = await installedPluginVersion(options.env, options.runClaude);
    const plugin: { id: string; from: string | null; to: string | null; updated: boolean; note: string } = {
      id: SHARED_PLUGIN_ID,
      from: installed,
      to: installed,
      updated: false,
      note: "",
    };
    if (!options.runClaude) plugin.note = `${SHARED_PLUGIN_ID}: Claude Code is not available here; skipped`;
    else if (installed === null) plugin.note = `${SHARED_PLUGIN_ID} is not installed; run spider setup claude`;
    else {
      const steps = [
        ["plugin", "marketplace", "update", SHARED_MARKETPLACE],
        ["plugin", "update", SHARED_PLUGIN_ID, "--json"],
      ];
      for (const args of steps) {
        const ran = await options.runClaude(args);
        if (!ran) {
          plugin.note = INSTALL_CLAUDE_HINT;
          break;
        }
        if (ran.exitCode !== 0) {
          failed = true;
          plugin.note = `claude ${args.join(" ")} failed: ${ran.output.trim() || `exit ${ran.exitCode}`}`;
          break;
        }
        if (args[1] === "update") plugin.to = updatedVersion(ran.output) ?? installed;
      }
      if (!plugin.note) {
        plugin.updated = plugin.to !== installed;
        restart ||= plugin.updated;
        plugin.note = plugin.updated
          ? `Updated ${SHARED_PLUGIN_ID} ${installed} → ${plugin.to}`
          : `${SHARED_PLUGIN_ID} ${installed} is up to date`;
      }
    }
    lines.push(plugin.note);

    // Generated agent files.
    const files = await refreshAgentFiles(options.env);
    const refreshed = files.filter((f) => f.next !== undefined).map((f) => f.path);
    const unmanaged = files.filter((f) => f.state === "unmanaged").map((f) => f.path);
    restart ||= refreshed.length > 0;
    lines.push(
      refreshed.length
        ? `Refreshed the Spider Tracker section of ${refreshed.length} agent file${refreshed.length === 1 ? "" : "s"}`
        : "Agent files are up to date",
    );
    for (const path of unmanaged) lines.push(`  left as is (no generated Spider Tracker section): ${path}`);
    if (restart) lines.push("Restart Claude Code sessions to load the updates.");

    output(opts, { cli, plugin, agents: { refreshed, unmanaged }, restart }, () => lines.join("\n"));
    if (failed) result.exitCode = EXIT.unexpected;
  });

  // For Claude Code's MCP `headersHelper`: prints {"Authorization": "Bearer …"} from the same
  // credentials the CLI uses, so .mcp.json needs no exported variable. With --server, only a key
  // for that server: {} (no headers) when the key in use belongs to another one.
  program
    .command("mcp-headers")
    .description("print MCP request headers as JSON (for Claude Code's headersHelper); --server: only a key for that server")
    .action(async () => {
      const { server } = globals();
      const credentials = server ? await credentialsOn(options, globals(), server) : await credentialsFor(options, globals());
      if (!credentials) {
        stderr.write(`spider mcp-headers: no key for server ${server} (the agent in use is on another server or none is saved)\n`);
        stdout.write("{}\n");
        return;
      }
      stdout.write(`${JSON.stringify({ Authorization: `Bearer ${credentials.token}` })}\n`);
    });

  const relationCommand = (name: "link" | "unlink", description: string) =>
    withJson(
      program
        .command(name)
        .description(description)
        .argument("<key>", "this task, e.g. ST-12")
        .argument("<kind>", "blocks | blocked-by | relates | duplicates | duplicated-by")
        .argument("<task>", "the other task, e.g. ST-15"),
    ).action(async (key: string, rawKind: string, other: string, opts: JsonOption) => {
      const kind = parseRelationKind(rawKind);
      const self = taskKey(key, cwd, git);
      const target = taskKey(other, cwd, git);
      const { sdk, org } = conn();
      const client = await sdk();
      if (name === "link") await client.tasks.relations.add(await org(), self, { kind, task: target });
      else await client.tasks.relations.remove(await org(), self, { kind, task: target });
      const summary = { task: self, kind, other: target, linked: name === "link" };
      output(opts, summary, () => `${name === "link" ? "Linked" : "Unlinked"}: ${self} ${kind.replace("_", " ")} ${target}`);
    });
  relationCommand("link", "link two tasks, e.g. spider link ST-1 blocks ST-2");
  relationCommand("unlink", "remove a link between two tasks");

  withJson(program.command("tags").description("list the organization's tags")).action(async (opts: JsonOption) => {
    const items = await conn().tags();
    output(opts, { items }, () => (items.length ? items.map((t) => t.name).join("\n") : "No tags"));
  });

  withJson(
    program.command("projects").description("list projects").option("--archived", "include archived projects"),
  ).action(async (opts: JsonOption & { archived?: boolean }) => {
    const { sdk, org } = conn();
    const { items } = await (await sdk()).projects.list(await org(), { archived: opts.archived });
    output(opts, { items }, () => items.map(projectLine).join("\n"));
  });

  const projectCommand = program.command("project").description("manage projects (create, change, archive: owners, admins and their agents)");

  withJson(
    projectCommand
      .command("create")
      .description("create a project with the default statuses")
      .requiredOption("--key <KEY>", "2–10 letters or digits, starting with a letter; prefixes task keys")
      .requiredOption("--name <text>", "name")
      .option("--description <text>", "description (Markdown)"),
  ).action(async (opts: JsonOption & { key: string; name: string; description?: string }) => {
    const { sdk, org } = conn();
    const created = await (await sdk()).projects.create(await org(), {
      key: opts.key,
      name: opts.name,
      description: opts.description,
    });
    output(opts, created, () => `Created ${projectLine(created)}`);
  });

  withJson(projectCommand.command("view").description("show a project, its statuses and task counts").argument("<key>")).action(
    async (key: string, opts: JsonOption) => {
      const { sdk, org } = conn();
      const client = await sdk();
      const slug = await org();
      const [detail, tasks, documents] = await Promise.all([
        client.projects.get(slug, key),
        client.tasks.list(slug, key),
        // Servers from before documents (ST-21) have no such route.
        client.documents
          .list(slug, { project: key.toUpperCase() })
          .then((r) => r.items)
          .catch(() => [] as DocumentSummaryDto[]),
      ]);
      const rulesDoc = detail.rulesDocumentId ? await client.documents.get(slug, detail.rulesDocumentId) : null;
      // ProjectRulesDto, as MCP get_project and whoami give them.
      const rules = rulesDoc && projectRulesView(detail, rulesDoc);
      const statuses = detail.statuses.map((s) => ({ ...s, taskCount: tasks.items.filter((t) => t.statusId === s.id).length }));
      const nameWidth = Math.max(0, ...statuses.map((s) => s.name.length));
      // MCP get_project has the same shape, without taskCount.
      output(opts, { ...detail, statuses, rules, documents }, () =>
        [
          projectLine(detail),
          `Created ${detail.createdAt}${detail.archivedAt ? ` · Archived ${detail.archivedAt}` : ""}`,
          "",
          "Statuses:",
          ...statuses.map((s) => `  ${s.name.padEnd(nameWidth)}  ${s.taskCount}`),
          ...(detail.description ? ["", detail.description] : []),
          ...(rules ? ["", `Rules for agents: ${rules.title} (${rules.documentId}, v${rules.version})`, "", rules.content] : []),
        ].join("\n"),
      );
    },
  );

  withJson(
    projectCommand
      .command("update")
      .description("change a project's name, description or rules for agents (the key can't change)")
      .argument("<key>")
      .option("--name <text>", "name")
      .option("--description <text>", 'description (Markdown; "" clears it)')
      .option("--rules <document-id>", 'one of the project\'s documents as its rules for agents ("" clears them); its agents are notified'),
  ).action(async (key: string, opts: JsonOption & { name?: string; description?: string; rules?: string }) => {
    const input: UpdateProjectInput = {};
    if (opts.name !== undefined) input.name = opts.name;
    if (opts.description !== undefined) input.description = opts.description === "" ? null : opts.description;
    if (opts.rules !== undefined) input.rulesDocumentId = opts.rules === "" ? null : opts.rules;
    if (Object.keys(input).length === 0) throw usageError("Nothing to update. Pass --name, --description or --rules");
    const { sdk, org } = conn();
    const updated = await (await sdk()).projects.update(await org(), key, input);
    output(opts, updated, () => `Updated ${projectLine(updated)}`);
  });

  withJson(
    projectCommand
      .command("archive")
      .description("archive a project: hidden from lists, no new tasks")
      .argument("<key>")
      .option("--undo", "restore an archived project"),
  ).action(async (key: string, opts: JsonOption & { undo?: boolean }) => {
    const { sdk, org } = conn();
    const client = await sdk();
    const result = await (opts.undo ? client.projects.unarchive : client.projects.archive)(await org(), key);
    output(opts, result, () => `${opts.undo ? "Restored" : "Archived"} ${result.key}  ${result.name}`);
  });

  const task = program.command("task").description("work with tasks");

  withJson(
    task
      .command("list")
      .description("list tasks")
      .option("--project <key>", "only this project (default: all)")
      .option("--status <name>", "status name or category")
      .option("--mine", "only tasks assigned to me (same as --assignee me)")
      .option(
        "--assignee <handle>",
        'assigned to any of these: handles (deactivated too), "me", "mine" (your person and all their agents) or "none"; repeatable or comma-separated',
        collect,
      )
      .option("--tag <name>", "carrying all of these tags; repeatable or comma-separated", collect)
      .option("--any-tag", "with --tag: carrying any of the tags instead of all")
      .option("--priority <0-4>", "any of these priorities (0-4 or a name); repeatable or comma-separated", collect)
      .option("--overdue", "only tasks past their target date (UTC) that aren't done or canceled")
      .option("--limit <n>", "at most n tasks", "50"),
  ).action(async (opts: TaskListOptions) => {
    const limit = parseLimit(opts.limit);
    const { sdk, org, whoami, actors, project, describe } = conn();
    const slug = await org();
    const keys = opts.project ? [opts.project.toUpperCase()] : (await (await sdk()).projects.list(slug)).items.map((p) => p.key);
    const priority = opts.priority?.map(parsePriority);
    const handles = [...(opts.assignee ?? []), ...(opts.mine ? ["me"] : [])];
    let assignee: string[] | undefined;
    // The client-side re-check (see matchesTaskFilter) can't take "mine": it gets actor ids.
    let assigneeCheck: string[] | undefined;
    if (handles.length) {
      // Deactivated actors too, so tasks still assigned to them can be found (ST-65).
      const special = (h: string) => normalizeHandle(h) === "none" || normalizeHandle(h) === "mine";
      const none = handles.some((h) => normalizeHandle(h) === "none");
      const mine = handles.some((h) => normalizeHandle(h) === "mine");
      const others = handles.filter((h) => !special(h));
      const me = (await whoami()).actor;
      const ids = others.length ? resolveAssignees(await actors(), me.id, others) : [];
      assignee = [...ids, ...(none ? ["none"] : []), ...(mine ? ["mine"] : [])];
      const mineIds = mine ? mineActorIds(me, await actors()) : [];
      assigneeCheck = [...ids, ...(none ? ["none"] : []), ...mineIds];
    }

    // Resolved here too, so the client can re-apply the filter for older servers (see matchesTaskFilter).
    const tagIds = opts.tag?.length ? resolveTags(await conn().tags(), opts.tag) : undefined;
    const tagMatch = opts.anyTag ? "any" : undefined;
    const found: TaskDto[] = [];
    const statusNames = new Set<string>();
    let statusKnown = false;
    for (const key of keys) {
      const detail = await project(key);
      let status: string[] | undefined;
      if (opts.status !== undefined) {
        // A status unknown in one project may exist in another; it is an error only if no project has it.
        status = matchStatuses(detail, opts.status).map((s) => s.id);
        detail.statuses.forEach((s) => statusNames.add(s.name));
        if (status.length === 0) continue;
        statusKnown = true;
      }
      const overdue = opts.overdue ? { statuses: detail.statuses } : undefined;
      const { items } = await (await sdk()).tasks.list(slug, key, { status, assignee, tags: opts.tag, tagMatch, priority, overdue: opts.overdue });
      found.push(...items.filter((t) => matchesTaskFilter(t, { statusIds: status, assignee: assigneeCheck, tagIds, tagMatch, priority, overdue })));
      if (found.length >= limit) break;
    }
    if (opts.status !== undefined && !statusKnown) {
      throw usageError(`Unknown status "${opts.status}". Valid statuses: ${[...statusNames].join(", ")}`);
    }

    const items = await Promise.all(found.slice(0, limit).map(describe));
    output(opts, { items }, () => (items.length ? taskLines(items) : "No tasks"));
  });

  withJson(task.command("view").description("show a task (default: the current branch's)").argument("[key]")).action(
    async (key: string | undefined, opts: JsonOption) => {
      const { sdk, org, describe } = conn();
      const client = await sdk();
      const resolved = taskKey(key, cwd, git);
      const [found, subtasks, relations, documents] = await Promise.all([
        client.tasks.get(await org(), resolved).then(describe),
        // Servers from before sub-tasks (ST-9), relations (ST-10) and documents (ST-21) have no such routes.
        client.tasks
          .subtasks(await org(), resolved)
          .then(async (r) => Promise.all(r.items.map(describe)))
          .catch(() => [] as CliTask[]),
        client.tasks.relations
          .list(await org(), resolved)
          .then((r) => r.items.map(relationView))
          .catch(() => [] as RelationView[]),
        client.documents
          .list(await org(), { task: resolved })
          .then((r) => r.items)
          .catch(() => [] as DocumentSummaryDto[]),
      ]);
      // The same shape as MCP get_task (TaskDetailView).
      output(opts, { ...found, subtasks, relations, documents }, () =>
        [
          taskDetail(found),
          ...(relations.length ? ["", "Links:", ...relations.map((r) => `  ${r.kind.replace("_", " ")} ${r.task}  ${r.title}`)] : []),
          ...(subtasks.length ? ["", "Sub-tasks:", taskLines(subtasks)] : []),
          ...(documents.length ? ["", "Documents:", documentLines(documents)] : []),
        ].join("\n"),
      );
    },
  );

  taskOptions(
    task
      .command("create")
      .description("create a task")
      .requiredOption("--project <key>", "project key, e.g. ST")
      .requiredOption("--title <text>", "title"),
  ).action(async (opts: TaskFields & { project: string; title: string }) => {
    const projectKey = opts.project.toUpperCase();
    const { sdk, org, describe } = conn();
    const input: CreateTaskInput = { ...(await taskInput(projectKey, opts)), title: opts.title };
    const created = await describe(await (await sdk()).tasks.create(await org(), projectKey, input));
    output(opts, created, () => taskLines([created]));
  });

  /** Updates several tasks through the bulk endpoint and prints one line per task (ST-106). */
  const bulkUpdate = async (
    target: Pick<BulkUpdateTasksInput, "keys" | "filter">,
    changes: TaskChanges,
    dryRun: boolean,
    hints: { nothing: string; apply?: string },
    opts: JsonOption,
  ) => {
    const { sdk, org, whoami, members, tags, describe } = conn();
    const set: BulkUpdateTasksInput["set"] = {};
    if (changes.status !== undefined) set.status = changes.status;
    if (changes.priority !== undefined) set.priority = parsePriority(changes.priority);
    if (changes.assign !== undefined) set.assigneeIds = resolveAssignees(await members(), (await whoami()).actor.id, changes.assign);
    if (changes.tag !== undefined) set.tagIds = resolveTags(await tags(), changes.tag);
    if (changes.parent !== undefined) {
      set.parentId = changes.parent.trim() === "" ? null : (await (await sdk()).tasks.get(await org(), taskKey(changes.parent, cwd, git))).id;
    }
    if (changes.start !== undefined) set.startDate = parseDate(changes.start, "--start");
    if (changes.target !== undefined) set.targetDate = parseDate(changes.target, "--target");
    if (Object.keys(set).length === 0) throw usageError(hints.nothing);

    const response = await (await sdk()).tasks.bulkUpdate(await org(), { ...target, set, dryRun });
    const results = await Promise.all(
      response.results.map(async (r) => ({ ...r, task: r.task ? await describe(r.task) : null })),
    );
    output(opts, { ...response, results }, () => bulkLines(response.dryRun, results, response.summary, hints.apply));
    if (response.summary.failed > 0) result.exitCode = EXIT.unexpected;
  };

  taskOptions(
    task
      .command("update")
      .description(
        "change a task (default: the current branch's), several keys, or the tasks matching --project and filters; --assign replaces the assignees",
      )
      .argument("[keys...]", "task keys, e.g. ST-2 ST-3 (default: the current branch's)")
      .option("--title <text>", "title (one task only)")
      .option("--set-status <name>", "new status: the same as --status, which filters tasks with --project")
      .option("--set-priority <0-4>", "new priority: the same as --priority, which filters with --project")
      .option("--set-assign <handle>", "new assignees: the same as --assign; repeatable or comma-separated", collect)
      .option("--set-tag <name>", "new tags: the same as --tag, which filters with --project; repeatable or comma-separated", collect)
      .option("--set-parent <key>", 'new parent: the same as --parent, which filters with --project ("" makes them top-level)')
      .option("--set-start <date>", 'new start date: the same as --start ("" clears it)')
      .option("--set-target <date>", 'new target date: the same as --target ("" clears it)')
      .option("--project <key>", "update the tasks of this project matching --status, --parent, --assignee, --tag, --priority, --overdue")
      .option("--overdue", "with --project: only tasks past their target date that aren't done or canceled")
      .option("--assignee <handle>", 'with --project: assigned to any of these, "me", "mine" or "none"; repeatable or comma-separated', collect)
      .option("--any-tag", "with --project and --tag: any of the tags instead of all")
      .option("--yes", "with --project: apply the changes (without it, only list what would change)")
      .option("--dry-run", "list what would change without changing anything"),
  ).action(async (keys: string[], opts: TaskUpdateOptions) => {
    if (opts.project !== undefined) {
      // Filter mode: the task-field flags select tasks; changes come only from --set-*.
      if (keys.length > 0) throw usageError("Pass task keys or --project with filters, not both");
      for (const [flag, value] of [
        ["--title", opts.title],
        ["--description", opts.description],
        ["--assign", opts.assign],
        ["--start", opts.start],
        ["--target", opts.target],
      ] as const) {
        if (value !== undefined) {
          throw usageError(
            `${flag} can't be used with --project; changes go in --set-status, --set-priority, --set-assign, --set-tag, --set-parent, --set-start and --set-target`,
          );
        }
      }
      if (opts.parent !== undefined && !parseTaskKey(opts.parent.trim())) {
        throw usageError(`Invalid task key "${opts.parent}" in --parent. Expected something like ST-12`);
      }
      const filter: BulkUpdateTasksInput["filter"] = {
        project: opts.project.toUpperCase(),
        status: opts.status === undefined ? undefined : [opts.status],
        parent: opts.parent?.trim(),
        assignee: opts.assignee,
        tags: opts.tag,
        tagMatch: opts.anyTag ? "any" : undefined,
        priority: opts.priority?.split(",").map(parsePriority),
        overdue: opts.overdue ? true : undefined,
      };
      const changes: TaskChanges = {
        status: opts.setStatus,
        priority: opts.setPriority,
        assign: opts.setAssign,
        tag: opts.setTag,
        parent: opts.setParent,
        start: opts.setStart,
        target: opts.setTarget,
      };
      await bulkUpdate({ filter }, changes, opts.dryRun === true || !opts.yes, {
        nothing: "Nothing to update. With --project, pass --set-status, --set-priority, --set-assign, --set-tag, --set-parent, --set-start or --set-target",
        apply: opts.dryRun ? undefined : "Run again with --yes to apply.",
      }, opts);
      return;
    }

    if (opts.assignee !== undefined || opts.anyTag || opts.overdue) {
      throw usageError("--assignee, --any-tag and --overdue filter tasks; use them with --project (--assign sets the assignees)");
    }
    // Outside filter mode, --status and --set-status (and the others) both set the field.
    const pick = (name: string, plain: string | undefined, set: string | undefined) => {
      if (plain !== undefined && set !== undefined) throw usageError(`Pass --${name} or --set-${name}, not both`);
      return set ?? plain;
    };
    const pickList = (name: string, plain: string[] | undefined, set: string[] | undefined) => {
      if (plain !== undefined && set !== undefined) throw usageError(`Pass --${name} or --set-${name}, not both`);
      return set ?? plain;
    };
    const changes: TaskChanges = {
      status: pick("status", opts.status, opts.setStatus),
      priority: pick("priority", opts.priority, opts.setPriority),
      assign: pickList("assign", opts.assign, opts.setAssign),
      tag: pickList("tag", opts.tag, opts.setTag),
      parent: pick("parent", opts.parent, opts.setParent),
      start: pick("start", opts.start, opts.setStart),
      target: pick("target", opts.target, opts.setTarget),
    };

    if (keys.length <= 1 && !opts.dryRun) {
      const resolved = taskKey(keys[0], cwd, git);
      const input = await taskInput(projectKeyOf(resolved), { ...opts, ...changes });
      if (Object.keys(input).length === 0) throw usageError("Nothing to update. Pass --title, --status, --assign, …");
      await update(resolved, input, opts);
      return;
    }

    if (opts.title !== undefined || opts.description !== undefined) {
      throw usageError("--title and --description change one task at a time");
    }
    const resolvedKeys = keys.length ? keys.map((k) => taskKey(k, cwd, git)) : [taskKey(undefined, cwd, git)];
    await bulkUpdate({ keys: resolvedKeys }, changes, opts.dryRun === true, {
      nothing: "Nothing to update. Pass --status, --priority, --assign, --tag, --parent, --start or --target",
    }, opts);
  });

  /**
   * Checks out the task's branch (`st-12-short-title`) for `spider start`: kept when the current branch already
   * names the task; skipped outside a repository. Returns the branch worked on, or null.
   */
  const checkoutTaskBranch = (key: string, title: string): { branch: string | null; note?: string } => {
    if (!isRepo(cwd, git)) return { branch: null };
    const current = currentBranch(cwd, git);
    if (current && taskKeysIn(current).includes(key)) return { branch: current };
    const name = branchNameFor(key, title);
    if (isDirty(cwd, git)) stderr.write("Warning: the working tree has uncommitted changes; they move to the new branch.\n");
    try {
      const { created, tracking } = createOrSwitchBranch(cwd, name, git);
      const from = current ?? "a detached HEAD";
      const what = tracking ? `new branch ${name} tracking ${tracking}` : created ? `new branch ${name}` : `existing branch ${name}`;
      return { branch: name, note: `Git: switched ${cwd} from ${from} to ${what} (--no-branch leaves git alone)` };
    } catch (err) {
      stderr.write(`Warning: couldn't switch to branch ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      return { branch: null };
    }
  };

  type StartOptions = JsonOption & { branch: boolean };
  const startTask = async (key: string | undefined, opts: StartOptions) => {
    const resolved = taskKey(key, cwd, git);
    const { sdk, org, whoami, project, describe } = conn();
    const client = await sdk();
    const [current, detail, who] = await Promise.all([
      client.tasks.get(await org(), resolved),
      project(projectKeyOf(resolved)),
      whoami(),
    ]);
    const assigneeIds = [...new Set([...current.assigneeIds, who.actor.id])];
    const started = await describe(
      await client.tasks.update(await org(), resolved, { statusId: firstStatus(detail, "in_progress").id, assigneeIds }),
    );
    const { branch, note } = opts.branch ? checkoutTaskBranch(resolved, started.title) : { branch: null };
    output(opts, { ...started, branch }, () => [taskLines([started]), ...(note ? [note] : [])].join("\n"));
  };
  const startCommand = (cmd: Command) =>
    withJson(
      cmd
        .description("assign me, move to the first in-progress status and switch to the task's git branch")
        .argument("[key]")
        .option("--no-branch", "don't create or switch git branches"),
    ).action(startTask);

  startCommand(task.command("start"));
  startCommand(program.command("start"));

  withJson(task.command("done").description("move to the first done status").argument("[key]")).action(
    async (key: string | undefined, opts: JsonOption) => {
      const resolved = taskKey(key, cwd, git);
      const detail = await conn().project(projectKeyOf(resolved));
      await update(resolved, { statusId: firstStatus(detail, "done").id }, opts);
    },
  );

  withJson(
    program
      .command("comment")
      .description("comment on a task; @handle mentions notify people and agents")
      .argument("<args...>", "[key] text — the key defaults to the one in the git branch"),
  ).action(async (args: string[], opts: JsonOption) => {
    const [first, ...rest] = args;
    const explicitKey = first !== undefined && rest.length > 0 && parseTaskKey(first) ? first : undefined;
    const body = (explicitKey ? rest : args).join(" ").trim();
    if (!body) throw usageError("Nothing to say. Usage: spider comment [ST-12] \"text\"");
    const key = taskKey(explicitKey, cwd, git);
    const { sdk, org, actors } = conn();
    const comment = await (await sdk()).comments.create(await org(), key, { body });
    output(opts, commentView(comment, await actors()), () => `Commented on ${comment.taskKey}`);
  });

  withJson(program.command("comments").description("show a task's comments").argument("[key]")).action(
    async (key: string | undefined, opts: JsonOption) => {
      const resolved = taskKey(key, cwd, git);
      const { sdk, org, actors } = conn();
      const [{ items }, rows] = await Promise.all([(await sdk()).comments.list(await org(), resolved), actors()]);
      const handle = (id: string) => actorHandle(rows, id);
      output(opts, { items: items.map((c) => commentView(c, rows)) }, () =>
        items.length === 0
          ? `No comments on ${resolved}`
          : items.map((c) => `@${handle(c.authorId)} · ${c.createdAt.slice(0, 16).replace("T", " ")}\n${c.body}`).join("\n\n"),
      );
    },
  );

  withJson(
    program
      .command("inbox")
      .description("your notifications: mentions, assignments, comments and replies, and changed project rules")
      .option("--all", "include items already read")
      .option("--wait <seconds>", "wait up to this long (max 25) for a new item")
      .option("--mark-read", "mark the listed items read"),
  ).action(async (opts: JsonOption & { all?: boolean; wait?: string; markRead?: boolean }) => {
    const { sdk, org } = conn();
    const client = await sdk();
    const slug = await org();
    const wait = opts.wait === undefined ? undefined : parseLimit(opts.wait);
    const { items } = await client.inbox.list(slug, { unread: !opts.all, wait, kinds: [...INBOX_KINDS] });
    const last = items.at(-1);
    if (opts.markRead && last) await client.inbox.markRead(slug, { upTo: last.id });
    output(opts, { items }, () =>
      items.length === 0
        ? "Inbox is empty"
        : items
            .map((i) => {
              const about = i.task?.key ?? (i.document ? `${i.document.projectKey} "${i.document.title}" (${i.document.id})` : "");
              const head = `#${i.id} ${about} ${i.kind} by @${i.from.handle}${i.readAt ? "" : " (unread)"}`;
              return i.comment ? `${head}\n  ${i.comment.body.split("\n").join("\n  ")}` : head;
            })
            .join("\n"),
    );
  });

  /** Content from --file: a path relative to cwd, or "-" for standard input. */
  const readContent = async (file: string) => {
    if (file !== "-") {
      return readFile(resolvePath(cwd, file), "utf8").catch(() => {
        throw usageError(`Can't read ${file}`);
      });
    }
    if (!options.stdin) throw usageError("No standard input to read");
    return options.stdin();
  };

  const doc = program.command("doc").description("work with documents (Markdown or HTML specs, plans, reports)");

  // The link syntax (ST-100, ST-115), shown under doc create and doc edit.
  const docLinksHelp = [
    "",
    "Links in Markdown content:",
    "  [[Title]]            another document, by title (the same project's first, then organization-wide)",
    "  [[Title|label]]      the same, shown as label; [[Title#Heading]] points at a section",
    "  [[doc:<id>]]         a document by id: survives renames, shows the document's current title",
    "  [[ST-12]]            a task (plain task keys such as ST-12 count too)",
    "Links show as backlinks and in the documents graph; links inside code are ignored.",
  ].join("\n");

  withJson(
    doc
      .command("list")
      .description("list documents: a task's, a project's (with its tasks'), or the whole organization's")
      .option("--project <key>", "only this project")
      .option("--task <key>", "only this task"),
  ).action(async (opts: JsonOption & { project?: string; task?: string }) => {
    const { sdk, org } = conn();
    const task = opts.task === undefined ? undefined : taskKey(opts.task, cwd, git);
    const { items } = await (await sdk()).documents.list(await org(), { project: opts.project?.toUpperCase(), task });
    output(opts, { items }, () => (items.length ? documentLines(items) : "No documents"));
  });

  withJson(
    doc
      .command("view")
      .description("show a document")
      .argument("<id>")
      // Not --version: that one prints the CLI's version.
      .option("--rev <n>", "an older version number"),
  ).action(async (id: string, opts: JsonOption & { rev?: string }) => {
    const { sdk, org, actors } = conn();
    const client = await sdk();
    const slug = await org();
    const current = await client.documents.get(slug, id);
    const old = opts.rev === undefined ? undefined : await client.documents.versions.get(slug, id, parseLimit(opts.rev));
    const shown = old ?? { ...current, createdAt: current.updatedAt };
    const rows = await actors();
    const handle = shown.authorId ? actorHandle(rows, shown.authorId) : "?";
    const item = old ? documentVersionView(current, old) : current;
    output(opts, item, () =>
      [
        `${shown.title}  (${documentScope(current)}, ${shown.format}, v${shown.version}${old ? ` of ${current.version}` : ""})`,
        `Saved by @${handle} · ${shown.createdAt.slice(0, 16).replace("T", " ")}`,
        ...(current.url ? [current.url] : []),
        "",
        shown.content,
      ].join("\n"),
    );
  });

  withJson(
    doc
      .command("diff")
      .description("show what changed between two versions of a document, as a unified diff of its lines")
      .argument("<id>")
      .requiredOption("--from <n>", "the older version")
      .option("--to <n>", "the newer version (default: the current one)"),
  ).action(async (id: string, opts: JsonOption & { from: string; to?: string }) => {
    const { sdk, org } = conn();
    const from = parseVersion(opts.from);
    const to = opts.to === undefined ? undefined : parseVersion(opts.to);
    const diff = await (await sdk()).documents.diff(await org(), id, { from, to });
    // DocumentDiffView: the API's diff plus its unified text, as MCP diff_document.
    output(opts, documentDiffView(diff), () => {
      const label = (v: typeof diff.from) => `${v.title} (v${v.version})`;
      const text = formatUnifiedDiff(diff.hunks, label(diff.from), label(diff.to));
      if (text) return text;
      const renamed = diff.from.title !== diff.to.title ? ` (title: ${diff.from.title} → ${diff.to.title})` : "";
      return `No changes in content between version ${diff.from.version} and ${diff.to.version}${renamed}`;
    });
  });

  withJson(
    doc
      .command("backlinks")
      .description("list the documents linking to a document, or mentioning a task ([[ST-12]] or a plain ST-12)")
      .argument("<id|task>", "a document id or a task key"),
  ).action(async (target: string, opts: JsonOption) => {
    const { sdk, org } = conn();
    const client = await sdk();
    const parsed = parseTaskKey(target.trim());
    const { items } = parsed
      ? await client.tasks.backlinks(await org(), `${parsed.projectKey}-${parsed.number}`)
      : await client.documents.backlinks(await org(), target);
    output(opts, { items }, () => (items.length ? documentLines(items) : "No documents link here"));
  });

  withJson(
    doc
      .command("graph")
      .description("the documents you can see as a graph: documents, their tasks and projects, and every link (use --json)"),
  ).action(async (opts: JsonOption) => {
    const { sdk, org } = conn();
    const graph = await (await sdk()).documents.graph(await org());
    output(opts, graph, () => {
      const titles = new Map(graph.documents.map((d) => [d.id, d.title]));
      const name = (to: (typeof graph.links)[number]["to"]) =>
        to.type === "document" ? (titles.get(to.id) ?? to.id) : to.type === "task" ? to.key : `${to.title} (no such document)`;
      return [
        `${graph.documents.length} documents, ${graph.tasks.length} tasks, ${graph.projects.length} projects, ${graph.links.length} links`,
        ...graph.links.map((l) => `${titles.get(l.from) ?? l.from} -> ${name(l.to)}`),
      ].join("\n");
    });
  });

  withJson(
    doc
      .command("create")
      .description("create a document (organization-wide unless --project or --task)")
      .requiredOption("--title <text>", "title")
      .option("--project <key>", "in this project")
      .option("--task <key>", "on this task (its project is implied)")
      .option("--format <md|html>", "md (default) or html; .html files default to html")
      .option("--file <path>", 'content from a file, or "-" for standard input')
      .addHelpText("after", docLinksHelp),
  ).action(async (opts: JsonOption & { title: string; project?: string; task?: string; format?: string; file?: string }) => {
    const { sdk, org } = conn();
    const content = opts.file === undefined ? "" : await readContent(opts.file);
    const format = opts.format !== undefined ? parseFormat(opts.format) : /\.html?$/i.test(opts.file ?? "") ? "html" : "md";
    const created = await (await sdk()).documents.create(await org(), {
      title: opts.title,
      format,
      content,
      project: opts.project,
      task: opts.task === undefined ? undefined : taskKey(opts.task, cwd, git),
    });
    output(opts, created, () => documentLines([created]));
  });

  withJson(
    doc
      .command("edit")
      .description(
        "save a new version of a document: replace its content (--file, with --base-version or --force), " +
          "or change part of it (--old/--new, --append, --section) without resending the rest",
      )
      .argument("<id>")
      .option("--title <text>", "new title")
      .option("--format <md|html>", "new format")
      .option("--file <path>", 'new content from a file, or "-" for standard input; with --append or --section, the text to write')
      .option("--old <text>", "replace this exact fragment (it must occur once; see --all) with --new")
      .option("--new <text>", "the fragment's replacement")
      .option("--all", "with --old: replace every occurrence")
      .option("--append", "add --text or --file to the end, on a new line")
      .option("--section <heading>", 'replace the body of this Markdown section (e.g. "## Decisions") with --text or --file')
      .option("--text <text>", "the text for --append or --section")
      .option("--base-version <n>", "the version your edit is based on (from doc view / doc list)")
      .option("--force", "without --base-version: save on top of whatever the current version is")
      .addHelpText("after", docLinksHelp),
  ).action(async (id: string, opts: DocEditOptions) => {
    const partial = opts.old !== undefined || opts.append === true || opts.section !== undefined;
    if (partial) return editDocumentPart(id, opts);
    if (opts.new !== undefined || opts.all || opts.text !== undefined) {
      throw usageError("--new and --all go with --old; --text goes with --append or --section");
    }
    if (opts.title === undefined && opts.format === undefined && opts.file === undefined) {
      throw usageError("Nothing to change. Pass --title, --format or --file, or a partial edit (--old/--new, --append, --section)");
    }
    // ST-21: the base version must be the one the edit was made from, not one re-read just before saving.
    if (opts.baseVersion === undefined && !opts.force) {
      throw usageError(
        "Pass --base-version <n> (the version you read with doc view) so a newer save isn't overwritten, or --force to overwrite whatever is current. To change part of the document, use --old/--new, --append or --section instead",
      );
    }
    const baseVersion = opts.baseVersion === undefined ? undefined : parseVersion(opts.baseVersion);
    const { sdk, org } = conn();
    const client = await sdk();
    const slug = await org();
    const content = opts.file === undefined ? undefined : await readContent(opts.file);
    const current = await client.documents.get(slug, id);
    const input: UpdateDocumentInput = { baseVersion: baseVersion ?? current.version, content };
    if (opts.title !== undefined) input.title = opts.title;
    if (opts.format !== undefined) input.format = parseFormat(opts.format);
    const saved = await client.documents.update(slug, id, input);
    output(opts, saved, () => {
      if (saved.version === current.version) return `No changes to ${saved.title}`;
      const lines = [`Saved ${saved.title} as version ${saved.version}`];
      // A rename rewrites [[Old title]] links in the documents linking here (ST-101).
      const { rewritten = [], skipped = [] } = saved.relinked ?? {};
      if (rewritten.length) lines.push(`Updated links in ${rewritten.map((d) => d.title).join(", ")}`);
      for (const d of skipped) {
        const why = d.reason === "rules" ? "project rules; only owners and admins can change them" : "it would pass 1 MB";
        lines.push(`Left [[${current.title}]] in ${d.title} (${d.id}): ${why}`);
      }
      return lines.join("\n");
    });
  });

  /**
   * One partial edit (ST-116). Without --base-version it applies to the current version and
   * fails (conflict) if the fragment or section isn't there, so it never overwrites anyone.
   */
  async function editDocumentPart(id: string, opts: DocEditOptions) {
    const modes = [opts.old !== undefined, opts.append === true, opts.section !== undefined].filter(Boolean).length;
    if (modes > 1) throw usageError("Pass one of --old/--new, --append or --section");
    if (opts.title !== undefined || opts.format !== undefined) {
      throw usageError("--title and --format can't be combined with a partial edit; change them in a separate doc edit");
    }
    let edit: DocumentEdit;
    if (opts.old !== undefined) {
      if (opts.new === undefined) throw usageError('--old needs --new (use --new "" to delete the fragment)');
      if (opts.text !== undefined || opts.file !== undefined) throw usageError("--old/--new take the text inline; --text and --file go with --append or --section");
      edit = { old: opts.old, new: opts.new, ...(opts.all ? { all: true } : {}) };
    } else {
      if (opts.new !== undefined || opts.all) throw usageError("--new and --all go with --old");
      if ((opts.text !== undefined) === (opts.file !== undefined)) {
        throw usageError(`${opts.append ? "--append" : "--section"} needs the text: pass --text <text> or --file <path|->`);
      }
      const text = opts.text ?? (await readContent(opts.file ?? "-"));
      edit = opts.section !== undefined ? { section: opts.section, content: text } : { append: text };
    }
    const baseVersion = opts.baseVersion === undefined ? undefined : parseVersion(opts.baseVersion);
    const { sdk, org } = conn();
    const client = await sdk();
    const slug = await org();
    const before = baseVersion ?? (await client.documents.get(slug, id)).version;
    const saved = await client.documents.edit(slug, id, { baseVersion, edits: [edit] });
    output(opts, saved, () =>
      saved.version === before ? `No changes to ${saved.title}` : `Saved ${saved.title} as version ${saved.version}`,
    );
  }

  withJson(
    doc
      .command("move")
      .description("move a document to another project, or make it organization-wide; keeps its id and versions")
      .argument("<id>")
      .option("--project <key>", "target project")
      .option("--org", "make the document organization-wide"),
  ).action(async (id: string, opts: JsonOption & { project?: string; org?: boolean }) => {
    if ((opts.project !== undefined) === (opts.org === true)) {
      throw usageError("Pass exactly one of --project <key> or --org");
    }
    const { sdk, org } = conn();
    const moved = await (await sdk()).documents.move(await org(), id, { project: opts.org ? null : (opts.project ?? "").toUpperCase() });
    output(opts, moved, () => `Moved ${moved.title} to ${moved.projectKey ?? "the organization"}`);
  });

  program
    .command("channel")
    .description("run as a Claude Code channel (stdio MCP): pushes your inbox into the session")
    .action(async () => {
      const { sdk, whoami } = conn();
      const [client, who] = await Promise.all([sdk(), whoami()]);
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { createChannel } = await import("./channel");
      const channel = createChannel({
        client,
        org: who.organization.slug,
        handle: who.actor.handle,
        log: (message) => stderr.write(`spider channel: ${message}\n`),
      });
      const stop = new AbortController();
      const transport = new StdioServerTransport();
      const closed = new Promise<void>((resolve) => {
        transport.onclose = () => {
          stop.abort();
          resolve();
        };
      });
      await channel.server.connect(transport);
      stderr.write(`spider channel: delivering @${who.actor.handle}'s inbox in ${who.organization.slug}\n`);
      void channel.pump(stop.signal);
      await closed;
    });

  /**
   * For "not found" and "forbidden": which saved agent acted, when it sees only some projects. A task
   * in another project reads as missing, and the default agent is easy to use by mistake (ST-107).
   */
  const scopeHint = async (): Promise<string> => {
    const entry = api ? (await api.credentials.catch(() => undefined))?.entry : undefined;
    if (!api || !entry?.saved.projects) return "";
    const { via } = await api.credentials;
    return ` (acting as ${entry.ref}${via ? `, ${via}` : ""}, which sees only ${scopeOf(entry)}; pass --as <agent> to act as another)`;
  };

  return { program, result, scopeHint };
}

/** Runs the CLI with `argv` (arguments after the program name) and resolves to the exit code. */
export async function run(argv: string[], options: RunOptions): Promise<number> {
  const json = argv.includes("--json");
  const fail = (err: CliError) => {
    // Every failure says something, even when the cause had no message (ST-107).
    const message = err.message.trim() || `Failed with ${err.code === "error" ? "an unknown error" : err.code} (exit code ${err.exitCode})`;
    options.stderr.write(
      json ? `${JSON.stringify({ error: { code: err.code, message } })}\n` : `spider: ${message}\n`,
    );
    return err.exitCode;
  };

  // The passive update notice: started now (no added latency), printed after the command.
  const notice =
    noticeAllowed(argv, options.env, options.isInteractive) && passiveNoticeFor(argv)
      ? startNotice(options.env, options.httpFetch ?? ((input, init) => fetch(input, init)), (line) => options.stderr.write(line))
      : undefined;
  const code = await runProgram(argv, options, json, fail);
  await notice?.().catch(() => {});
  return code;
}

async function runProgram(argv: string[], options: RunOptions, json: boolean, fail: (err: CliError) => number) {
  let built: ReturnType<typeof buildProgram> | undefined;
  try {
    built = buildProgram(options, options.cwd ?? process.cwd(), argv, json);
    await built.program.parseAsync(argv, { from: "user" });
    return built.result.exitCode ?? EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander's exitCode is 0 for --help, --version and `help`, and non-zero for real usage
      // errors (including a bare command group).
      if (err.exitCode === 0) return EXIT.ok;
      // Without --json, commander has printed the error; with it, report it in the JSON shape.
      return json ? fail(new CliError(EXIT.usage, err.message.replace(/^error: /, ""), "usage")) : EXIT.usage;
    }
    if (err instanceof CliError) return fail(err);
    if (err instanceof SpiderApiError) {
      const hint = err.status === 403 || err.status === 404 ? await built?.scopeHint().catch(() => "") : "";
      return fail(fromApiError(err, hint));
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(new CliError(EXIT.unexpected, message, "unexpected"));
  }
}
