import type { ActorDto, ProjectDetailDto, StatusDto, TaskDto, WhoAmIResponse } from "@repo/core/contracts";
import { parseTaskKey } from "@repo/core/schemas";
import type { CreateTaskInput, UpdateTaskInput } from "@repo/core/schemas";
import { SpiderApiError, createClient, type FetchLike } from "@repo/sdk";
import { Command, CommanderError } from "commander";
import { currentBranch, taskKeyFromBranch } from "./git";
import {
  CliError,
  EXIT,
  PRIORITY_NAMES,
  firstStatus,
  fromApiError,
  matchStatuses,
  parseLimit,
  parsePriority,
  resolveAssignees,
  resolveStatus,
  usageError,
  type ExitCode,
} from "./resolve";

export { EXIT, type ExitCode } from "./resolve";

export const DEFAULT_API_URL = "https://tracker-api.batele.plus";
const VERSION = "0.1.0";

export interface Writer {
  write(chunk: string): unknown;
}

export interface RunOptions {
  /** SPIDER_TOKEN (required) and SPIDER_API_URL. */
  env: Record<string, string | undefined>;
  /** Override the transport, e.g. to call the Hono app in tests. */
  fetch?: FetchLike;
  stdout: Writer;
  stderr: Writer;
  /** Where to look for the git branch when a task key is omitted. */
  cwd?: string;
}

/** A task as the CLI prints it with --json: the API task plus its status and assignee handles. */
export interface CliTask extends TaskDto {
  status: Pick<StatusDto, "id" | "name" | "category"> | null;
  assignees: string[];
}

interface JsonOption {
  json?: boolean;
}

interface TaskFields extends JsonOption {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assign?: string[];
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
function connect(options: RunOptions) {
  const token = options.env.SPIDER_TOKEN?.trim();
  if (!token) throw new CliError(EXIT.auth, "SPIDER_TOKEN is not set. Create an agent API key in the web app", "unauthorized");
  const client = createClient({
    baseUrl: options.env.SPIDER_API_URL?.trim() || DEFAULT_API_URL,
    token,
    source: "cli",
    fetch: options.fetch,
  });

  let who: Promise<WhoAmIResponse> | undefined;
  let members: Promise<ActorDto[]> | undefined;
  const projects = new Map<string, Promise<ProjectDetailDto>>();

  const whoami = () => (who ??= client.whoami());
  const org = async () => (await whoami()).organization.slug;
  const loadMembers = () => (members ??= org().then((slug) => client.members.list(slug).then((r) => r.items)));
  const project = (key: string) => {
    const upper = key.toUpperCase();
    let cached = projects.get(upper);
    if (!cached) {
      cached = org().then((slug) => client.projects.get(slug, upper));
      projects.set(upper, cached);
    }
    return cached;
  };

  /** Adds the status and assignee handles, for printing. */
  const describe = async (task: TaskDto): Promise<CliTask> => {
    const [detail, rows] = await Promise.all([project(projectKeyOf(task.key)), loadMembers()]);
    const status = detail.statuses.find((s) => s.id === task.statusId);
    return {
      ...task,
      status: status ? { id: status.id, name: status.name, category: status.category } : null,
      assignees: task.assigneeIds.map((id) => rows.find((m) => m.id === id)?.handle ?? id),
    };
  };

  return { client, whoami, org, members: loadMembers, project, describe };
}

type Api = ReturnType<typeof connect>;

const projectKeyOf = (taskKey: string) => parseTaskKey(taskKey)?.projectKey ?? taskKey.split("-")[0] ?? taskKey;

/** The task key given, or the one in the current branch name. */
function taskKey(given: string | undefined, cwd: string): string {
  if (given) {
    const parsed = parseTaskKey(given.trim());
    if (!parsed) throw usageError(`Invalid task key "${given}". Expected something like ST-12`);
    return `${parsed.projectKey}-${parsed.number}`;
  }
  const branch = currentBranch(cwd);
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
    `Status: ${task.status?.name ?? "?"} · Priority: ${PRIORITY_NAMES[task.priority]} · Assignees: ${assigneeList(task) || "none"}`,
    `Created ${task.createdAt} · Updated ${task.updatedAt}${task.completedAt ? ` · Completed ${task.completedAt}` : ""}`,
  ];
  if (task.description) lines.push("", task.description);
  return lines.join("\n");
}

/** Builds the command tree for one run; actions write to the run's streams. */
function buildProgram(options: RunOptions, cwd: string) {
  const { stdout, stderr } = options;
  let api: Api | undefined;
  const conn = () => (api ??= connect(options));
  const print = (text: string) => stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
  const output = (opts: JsonOption, json: unknown, human: () => string) =>
    print(opts.json ? JSON.stringify(json) : human());

  const program = new Command("spider")
    .description("Spider Tracker from the terminal. Auth: SPIDER_TOKEN (agent API key)")
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => stdout.write(s),
      writeErr: (s) => stderr.write(s),
    })
    .showHelpAfterError("(run with --help for usage)");

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
    return input;
  };

  const taskOptions = (cmd: Command) =>
    withJson(
      cmd
        .option("--description <text>", "description (Markdown)")
        .option("--status <name>", "status name or category, e.g. \"In Progress\" or in_progress")
        .option("--priority <0-4>", "0 none, 1 urgent, 2 high, 3 medium, 4 low")
        .option("--assign <handle>", "assignee handle or \"me\"; repeatable or comma-separated", collect),
    );

  /** Updates a task and prints the result. */
  const update = async (key: string, input: UpdateTaskInput, opts: JsonOption) => {
    const { client, org, describe } = conn();
    const task = await describe(await client.tasks.update(await org(), key, input));
    output(opts, task, () => taskLines([task]));
  };

  withJson(program.command("whoami").description("show the agent and organization the token acts as")).action(
    async (opts: JsonOption) => {
      const who = await conn().whoami();
      output(opts, who, () => `@${who.actor.handle} (${who.actor.name}, ${who.actor.role}) in ${who.organization.slug}`);
    },
  );

  withJson(program.command("projects").description("list projects")).action(async (opts: JsonOption) => {
    const { client, org } = conn();
    const { items } = await client.projects.list(await org());
    output(opts, { items }, () => items.map((p) => `${p.key}  ${p.name}`).join("\n"));
  });

  const task = program.command("task").description("work with tasks");

  withJson(
    task
      .command("list")
      .description("list tasks")
      .option("--project <key>", "only this project (default: all)")
      .option("--status <name>", "status name or category")
      .option("--mine", "only tasks assigned to me")
      .option("--limit <n>", "at most n tasks", "50"),
  ).action(async (opts: JsonOption & { project?: string; status?: string; mine?: boolean; limit: string }) => {
    const limit = parseLimit(opts.limit);
    const { client, org, whoami, project, describe } = conn();
    const slug = await org();
    const keys = opts.project ? [opts.project.toUpperCase()] : (await client.projects.list(slug)).items.map((p) => p.key);
    const me = opts.mine ? (await whoami()).actor.id : undefined;

    const found: TaskDto[] = [];
    const statusNames = new Set<string>();
    let statusKnown = false;
    for (const key of keys) {
      const detail = await project(key);
      let statusIds: Set<string> | undefined;
      if (opts.status !== undefined) {
        // A status unknown in one project may exist in another; it is an error only if no project has it.
        statusIds = new Set(matchStatuses(detail, opts.status).map((s) => s.id));
        detail.statuses.forEach((s) => statusNames.add(s.name));
        if (statusIds.size === 0) continue;
        statusKnown = true;
      }
      const { items } = await client.tasks.list(slug, key);
      found.push(
        ...items.filter((t) => (!statusIds || statusIds.has(t.statusId)) && (!me || t.assigneeIds.includes(me))),
      );
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
      const { client, org, describe } = conn();
      const found = await describe(await client.tasks.get(await org(), taskKey(key, cwd)));
      output(opts, found, () => taskDetail(found));
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
    const { client, org, describe } = conn();
    const input: CreateTaskInput = { ...(await taskInput(projectKey, opts)), title: opts.title };
    const created = await describe(await client.tasks.create(await org(), projectKey, input));
    output(opts, created, () => taskLines([created]));
  });

  taskOptions(
    task
      .command("update")
      .description("change a task (default: the current branch's); --assign replaces the assignees")
      .argument("[key]")
      .option("--title <text>", "title"),
  ).action(async (key: string | undefined, opts: TaskFields) => {
    const resolved = taskKey(key, cwd);
    const input = await taskInput(projectKeyOf(resolved), opts);
    if (Object.keys(input).length === 0) throw usageError("Nothing to update. Pass --title, --status, --assign, …");
    await update(resolved, input, opts);
  });

  withJson(
    task
      .command("start")
      .description("assign me and move to the first in-progress status")
      .argument("[key]"),
  ).action(async (key: string | undefined, opts: JsonOption) => {
    const resolved = taskKey(key, cwd);
    const { client, org, whoami, project } = conn();
    const [current, detail, who] = await Promise.all([
      client.tasks.get(await org(), resolved),
      project(projectKeyOf(resolved)),
      whoami(),
    ]);
    const assigneeIds = [...new Set([...current.assigneeIds, who.actor.id])];
    await update(resolved, { statusId: firstStatus(detail, "in_progress").id, assigneeIds }, opts);
  });

  withJson(task.command("done").description("move to the first done status").argument("[key]")).action(
    async (key: string | undefined, opts: JsonOption) => {
      const resolved = taskKey(key, cwd);
      const detail = await conn().project(projectKeyOf(resolved));
      await update(resolved, { statusId: firstStatus(detail, "done").id }, opts);
    },
  );

  return program;
}

/** Runs the CLI with `argv` (arguments after the program name) and resolves to the exit code. */
export async function run(argv: string[], options: RunOptions): Promise<ExitCode> {
  const json = argv.includes("--json");
  const fail = (err: CliError) => {
    options.stderr.write(
      json ? `${JSON.stringify({ error: { code: err.code, message: err.message } })}\n` : `spider: ${err.message}\n`,
    );
    return err.exitCode;
  };

  try {
    await buildProgram(options, options.cwd ?? process.cwd()).parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already printed the message (or the help/version text). Its exitCode is 0 for
      // --help, --version and `help`, and non-zero for real usage errors (including a bare command group).
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof CliError) return fail(err);
    if (err instanceof SpiderApiError) return fail(fromApiError(err));
    const message = err instanceof Error ? err.message : String(err);
    return fail(new CliError(EXIT.unexpected, message, "unexpected"));
  }
}
