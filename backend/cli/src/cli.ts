import type { ActorDto, ProjectDetailDto, StatusDto, TagDto, TaskDto, WhoAmIResponse } from "@repo/core/contracts";
import { parseTaskKey } from "@repo/core/schemas";
import type { CreateTaskInput, UpdateTaskInput } from "@repo/core/schemas";
import { SpiderApiError, createClient, type FetchLike } from "@repo/sdk";
import { Command, CommanderError } from "commander";
import { hostname } from "node:os";
import { deleteCredentials, readCredentials, writeCredentials } from "./credentials";
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
  resolveTags,
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
}

/** A task as the CLI prints it with --json: the API task plus its status and assignee handles. */
export interface CliTask extends TaskDto {
  status: Pick<StatusDto, "id" | "name" | "category"> | null;
  assignees: string[];
  tags: string[];
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
  tag?: string[];
  parent?: string;
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

/** SPIDER_TOKEN wins; otherwise the key saved by `spider login`. */
async function credentialsFor(options: RunOptions) {
  const token = options.env.SPIDER_TOKEN?.trim();
  if (token) return { token, baseUrl: apiUrlOf(options.env) };
  const saved = await readCredentials(options.env);
  if (saved) return { token: saved.token, baseUrl: options.env.SPIDER_API_URL?.trim() || saved.apiUrl };
  throw new CliError(EXIT.auth, "Not signed in. Run `spider login`, or set SPIDER_TOKEN to an agent API key", "unauthorized");
}

function connect(options: RunOptions) {
  const ready = credentialsFor(options).then(({ token, baseUrl }) =>
    createClient({ baseUrl, token, source: "cli", fetch: options.fetch }),
  );
  // Commands await `sdk()`; this only stops an early failure from being reported as unhandled.
  ready.catch(() => {});
  const sdk = () => ready;

  let who: Promise<WhoAmIResponse> | undefined;
  let members: Promise<ActorDto[]> | undefined;
  let tagList: Promise<TagDto[]> | undefined;
  const projects = new Map<string, Promise<ProjectDetailDto>>();

  const whoami = () => (who ??= ready.then((c) => c.whoami()));
  const org = async () => (await whoami()).organization.slug;
  const loadTags = () => (tagList ??= org().then(async (slug) => (await sdk()).tags.list(slug).then((r) => r.items)));
  const loadMembers = () => (members ??= org().then(async (slug) => (await sdk()).members.list(slug).then((r) => r.items)));
  const project = (key: string) => {
    const upper = key.toUpperCase();
    let cached = projects.get(upper);
    if (!cached) {
      cached = org().then(async (slug) => (await sdk()).projects.get(slug, upper));
      projects.set(upper, cached);
    }
    return cached;
  };

  /** Adds the status and assignee handles, for printing. */
  const describe = async (raw: TaskDto): Promise<CliTask> => {
    // Servers from before tags (ST-8) don't send tagIds.
    const task = { ...raw, tagIds: raw.tagIds ?? [] };
    const [detail, rows, tagRows] = await Promise.all([
      project(projectKeyOf(task.key)),
      loadMembers(),
      task.tagIds.length ? loadTags() : [],
    ]);
    const status = detail.statuses.find((s) => s.id === task.statusId);
    return {
      ...task,
      status: status ? { id: status.id, name: status.name, category: status.category } : null,
      assignees: task.assigneeIds.map((id) => rows.find((m) => m.id === id)?.handle ?? id),
      tags: task.tagIds.map((id) => tagRows.find((t) => t.id === id)?.name ?? id),
    };
  };

  return { sdk, whoami, org, members: loadMembers, tags: loadTags, project, describe };
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
  if (task.parentKey) lines.push(`Parent: ${task.parentKey}`);
  if (task.description) lines.push("", task.description);
  return lines.join("\n");
}

/** Builds the command tree for one run; actions write to the run's streams. */
function buildProgram(options: RunOptions, cwd: string, json = false) {
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
      input.parentId = opts.parent.trim() === "" ? null : (await (await sdk()).tasks.get(await org(), taskKey(opts.parent, cwd))).id;
    }
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
        .option("--parent <key>", 'parent task key, making this a sub-task ("" makes it top-level)'),
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
      output(opts, who, () => `@${who.actor.handle} (${who.actor.name}, ${who.actor.role}) in ${who.organization.slug}`);
    },
  );

  withJson(
    program
      .command("login")
      .description("sign in through the browser; saves an agent key for this device")
      .option("--name <device>", "what to call this device", defaultDeviceName())
      .option("--no-browser", "print the link instead of opening a browser"),
  ).action(async (opts: JsonOption & { name: string; browser: boolean }) => {
    const apiUrl = apiUrlOf(options.env);
    const client = createClient({ baseUrl: apiUrl, fetch: options.fetch });
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
        const path = await writeCredentials(options.env, {
          apiUrl,
          token: token.access_token,
          actor: { handle: token.actor.handle, name: token.actor.name },
          organization: { slug: token.organization.slug, name: token.organization.name },
          createdAt: new Date().toISOString(),
        });
        const summary = { actor: token.actor, organization: token.organization, credentials: path };
        output(opts, summary, () => `Signed in as @${token.actor.handle} in ${token.organization.slug}. Key saved to ${path}`);
        if (options.env.SPIDER_TOKEN) stderr.write("Note: SPIDER_TOKEN is set and takes precedence over the saved key.\n");
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

  withJson(program.command("logout").description("revoke and forget the key saved by spider login")).action(
    async (opts: JsonOption) => {
      const saved = await readCredentials(options.env);
      if (saved) {
        const client = createClient({ baseUrl: saved.apiUrl, token: saved.token, source: "cli", fetch: options.fetch });
        // Already revoked or deleted on the server: forgetting it locally is still right.
        await client.keys.revokeCurrent().catch((err: unknown) => {
          if (!(err instanceof SpiderApiError) || (err.status !== 401 && err.status !== 404)) throw err;
        });
        await deleteCredentials(options.env);
      }
      output(opts, { loggedOut: !!saved }, () => (saved ? `Signed out @${saved.actor.handle}` : "Not signed in"));
      if (options.env.SPIDER_TOKEN) stderr.write("SPIDER_TOKEN is still set in your environment.\n");
    },
  );

  // For Claude Code's MCP `headersHelper`: prints {"Authorization": "Bearer …"} from the same
  // credentials the CLI uses, so .mcp.json needs no exported variable.
  program
    .command("mcp-headers")
    .description("print MCP request headers as JSON (for Claude Code's headersHelper)")
    .action(async () => {
      const { token } = await credentialsFor(options);
      stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
    });

  withJson(program.command("tags").description("list the organization's tags")).action(async (opts: JsonOption) => {
    const items = await conn().tags();
    output(opts, { items }, () => (items.length ? items.map((t) => t.name).join("\n") : "No tags"));
  });

  withJson(program.command("projects").description("list projects")).action(async (opts: JsonOption) => {
    const { sdk, org } = conn();
    const { items } = await (await sdk()).projects.list(await org());
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
    const { sdk, org, whoami, project, describe } = conn();
    const slug = await org();
    const keys = opts.project ? [opts.project.toUpperCase()] : (await (await sdk()).projects.list(slug)).items.map((p) => p.key);
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
      const { items } = await (await sdk()).tasks.list(slug, key);
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
      const { sdk, org, describe } = conn();
      const client = await sdk();
      const resolved = taskKey(key, cwd);
      const [found, subtasks] = await Promise.all([
        client.tasks.get(await org(), resolved).then(describe),
        // Servers from before sub-tasks (ST-9) have no such route.
        client.tasks
          .subtasks(await org(), resolved)
          .then(async (r) => Promise.all(r.items.map(describe)))
          .catch(() => [] as CliTask[]),
      ]);
      output(opts, { ...found, subtasks }, () =>
        subtasks.length ? `${taskDetail(found)}\n\nSub-tasks:\n${taskLines(subtasks)}` : taskDetail(found),
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
    const { sdk, org, whoami, project } = conn();
    const [current, detail, who] = await Promise.all([
      (await sdk()).tasks.get(await org(), resolved),
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
    const key = taskKey(explicitKey, cwd);
    const { sdk, org } = conn();
    const comment = await (await sdk()).comments.create(await org(), key, { body });
    output(opts, comment, () => `Commented on ${comment.taskKey}`);
  });

  withJson(program.command("comments").description("show a task's comments").argument("[key]")).action(
    async (key: string | undefined, opts: JsonOption) => {
      const resolved = taskKey(key, cwd);
      const { sdk, org, members } = conn();
      const [{ items }, rows] = await Promise.all([(await sdk()).comments.list(await org(), resolved), members()]);
      const handle = (id: string) => rows.find((m) => m.id === id)?.handle ?? id;
      output(opts, { items }, () =>
        items.length === 0
          ? `No comments on ${resolved}`
          : items.map((c) => `@${handle(c.authorId)} · ${c.createdAt.slice(0, 16).replace("T", " ")}\n${c.body}`).join("\n\n"),
      );
    },
  );

  withJson(
    program
      .command("inbox")
      .description("your notifications: mentions, assignments, comments and replies")
      .option("--all", "include items already read")
      .option("--wait <seconds>", "wait up to this long (max 25) for a new item")
      .option("--mark-read", "mark the listed items read"),
  ).action(async (opts: JsonOption & { all?: boolean; wait?: string; markRead?: boolean }) => {
    const { sdk, org } = conn();
    const client = await sdk();
    const slug = await org();
    const wait = opts.wait === undefined ? undefined : parseLimit(opts.wait);
    const { items } = await client.inbox.list(slug, { unread: !opts.all, wait });
    const last = items.at(-1);
    if (opts.markRead && last) await client.inbox.markRead(slug, { upTo: last.id });
    output(opts, { items }, () =>
      items.length === 0
        ? "Inbox is empty"
        : items
            .map((i) => {
              const head = `#${i.id} ${i.task.key} ${i.kind} by @${i.from.handle}${i.readAt ? "" : " (unread)"}`;
              return i.comment ? `${head}\n  ${i.comment.body.split("\n").join("\n  ")}` : head;
            })
            .join("\n"),
    );
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
    await buildProgram(options, options.cwd ?? process.cwd(), json).parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander's exitCode is 0 for --help, --version and `help`, and non-zero for real usage
      // errors (including a bare command group).
      if (err.exitCode === 0) return EXIT.ok;
      // Without --json, commander has printed the error; with it, report it in the JSON shape.
      return json ? fail(new CliError(EXIT.usage, err.message.replace(/^error: /, ""), "usage")) : EXIT.usage;
    }
    if (err instanceof CliError) return fail(err);
    if (err instanceof SpiderApiError) return fail(fromApiError(err));
    const message = err instanceof Error ? err.message : String(err);
    return fail(new CliError(EXIT.unexpected, message, "unexpected"));
  }
}
