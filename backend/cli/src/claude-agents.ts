import {
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { configDir, type AgentEntry } from "./credentials";

// Claude Code agents that belong to saved Spider agents. New ones live in a private plugin the CLI
// owns, <configDir>/claude-plugin: a local marketplace `spider-local` with one plugin
// `spider-agents`, whose agents are agents/<server>/<org>/<handle>.md. Claude Code names a nested
// plugin agent by its folders and frontmatter name: `spider-agents:<server>:<org>:<name>`. Each
// file points back with `spider-agent: <server/org/handle>`. Older setups kept them in
// ~/.claude/agents/** (any subfolder, found by `name`); those are still found and removed.

export const MARKETPLACE = "spider-local";
export const PLUGIN = "spider-agents";
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

type Env = Record<string, string | undefined>;

export interface ClaudeAgentFile {
  path: string;
  name: string;
  /** What `claude --agent` takes: `spider-agents:<folders>:<name>` in the plugin, `name` in ~/.claude/agents. */
  qualifiedName: string;
  plugin: boolean;
  spider?: string;
}

export interface ClaudeAgentTarget {
  plugin: typeof PLUGIN;
  name: string;
  path: string;
  qualifiedName: string;
}

/** The private plugin's marketplace folder; undefined without a home or SPIDER_CONFIG_DIR. */
export function pluginRoot(env: Env): string | undefined {
  const dir = configDir(env);
  return dir && join(dir, "claude-plugin");
}

const pluginAgentsDir = (root: string) => join(root, PLUGIN, "agents");
const legacyAgentsDir = (home: string) => join(home, ".claude", "agents");

async function scanDir(
  dir: string,
  plugin: boolean,
): Promise<ClaudeAgentFile[]> {
  const names = await readdir(dir, { recursive: true }).then(
    (all) => all.filter((n) => n.endsWith(".md")).sort(),
    () => [] as string[],
  );
  return Promise.all(
    names.map(async (rel) => {
      const path = join(dir, rel);
      const text = await readFile(path, "utf8").catch(() => "");
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      const field = (key: string) =>
        new RegExp(`^${key}:[ \\t]*["']?(.*?)["']?[ \\t]*$`, "m").exec(
          front,
        )?.[1] || undefined;
      const parts = rel.split(/[\\/]/);
      const base = parts.pop() ?? rel;
      const name = field("name") ?? base.slice(0, -3);
      return {
        path,
        name,
        qualifiedName: plugin ? [PLUGIN, ...parts, name].join(":") : name,
        plugin,
        spider: field("spider-agent"),
      };
    }),
  );
}

/** Every agent file in the private plugin, then under ~/.claude/agents (subfolders included). */
export async function scanClaudeAgents(env: Env): Promise<ClaudeAgentFile[]> {
  const root = pluginRoot(env);
  return [
    ...(root ? await scanDir(pluginAgentsDir(root), true) : []),
    ...(env.HOME ? await scanDir(legacyAgentsDir(env.HOME), false) : []),
  ];
}

const refsOf = (entry: AgentEntry) =>
  new Set([entry.ref, `${entry.org}/${entry.agent}`, entry.agent]);

/** Agent files whose `spider-agent` names this saved agent. */
export function linkedClaudeAgents(
  files: ClaudeAgentFile[],
  entry: AgentEntry,
): ClaudeAgentFile[] {
  const refs = refsOf(entry);
  return files.filter((f) => f.spider !== undefined && refs.has(f.spider));
}

/**
 * The `--agent` to start with a saved agent: a linked file (the plugin's first), else a top-level
 * ~/.claude/agents/<handle>.md that isn't linked to another Spider agent.
 */
export async function claudeAgentFor(
  env: Env,
  entry: AgentEntry,
): Promise<string | undefined> {
  const files = await scanClaudeAgents(env);
  const linked = linkedClaudeAgents(files, entry)[0];
  if (linked) return linked.qualifiedName;
  if (!env.HOME) return undefined;
  const plain = join(legacyAgentsDir(env.HOME), `${entry.agent}.md`);
  return files.find((f) => f.path === plain && !f.spider)?.qualifiedName;
}

/**
 * Where this saved agent's Claude Code agent goes in the private plugin, with a `name` no other
 * agent file uses: the handle, else server-handle, else server-org-handle.
 */
export async function claudeAgentTarget(
  env: Env,
  entry: AgentEntry,
): Promise<ClaudeAgentTarget | undefined> {
  const root = pluginRoot(env);
  if (!root) return undefined;
  const files = await scanClaudeAgents(env);
  const mine = new Set(linkedClaudeAgents(files, entry).map((f) => f.path));
  const taken = new Set(
    files.filter((f) => !mine.has(f.path)).map((f) => f.name),
  );
  const candidates = [
    entry.agent,
    `${entry.server}-${entry.agent}`,
    `${entry.server}-${entry.org}-${entry.agent}`,
  ];
  const name =
    candidates.find((c) => !taken.has(c)) ??
    candidates[candidates.length - 1] ??
    entry.agent;
  return {
    plugin: PLUGIN,
    name,
    path: join(
      pluginAgentsDir(root),
      entry.server,
      entry.org,
      `${entry.agent}.md`,
    ),
    qualifiedName: [PLUGIN, entry.server, entry.org, name].join(":"),
  };
}

/** Writes the private plugin's marketplace and plugin manifests. */
export async function writePluginManifests(root: string) {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const author = { name: "Spider Tracker" };
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin", "marketplace.json"),
    json({
      name: MARKETPLACE,
      owner: author,
      metadata: {
        description:
          "Spider Tracker agents saved on this machine (written by the spider CLI)",
      },
      plugins: [
        {
          name: PLUGIN,
          source: `./${PLUGIN}`,
          description: "Claude Code agents for your Spider Tracker agents",
        },
      ],
    }),
  );
  await mkdir(join(root, PLUGIN, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(root, PLUGIN, ".claude-plugin", "plugin.json"),
    json({
      name: PLUGIN,
      version: "0.1.0",
      author,
      description:
        "Claude Code agents for your Spider Tracker agents; start one with spider claude <handle>",
    }),
  );
}

export interface AgentRole {
  description: string;
  prompt: string;
  projects: { key: string; name: string }[] | null;
}

const yamlString = (value: string) =>
  JSON.stringify(value.replace(/\s+/g, " ").trim());

/** The agent file: frontmatter, the role, and how it works in Spider Tracker. */
export function claudeAgentMarkdown(
  entry: AgentEntry,
  name: string,
  role: AgentRole,
): string {
  const projects = role.projects?.length
    ? role.projects.map((p) => `${p.key} (${p.name})`).join(", ")
    : "all projects";
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlString(role.description)}`,
    `spider-agent: ${entry.ref}`,
    "---",
    "",
    role.prompt.trim(),
    "",
    "## Spider Tracker",
    "",
    `You are @${entry.agent} in Spider Tracker (organization ${entry.org}), working in: ${projects}.`,
    "",
    `- In sessions started with \`spider claude ${entry.agent}\`, act through the \`spider\` MCP tools (whoami, list_tasks, start_task, add_comment, …); your inbox (mentions, assignments, replies) arrives as \`<channel source="spider" …>\` messages — answer with the channel's \`reply\` tool.`,
    `- For one-off CLI calls, use \`spider … --as ${entry.agent} --json\`.`,
    "- Stay within your projects. Never put secrets (API keys, tokens, passwords) in tasks or comments.",
    "",
  ].join("\n");
}

/** Writes (or replaces) this saved agent's Claude Code agent in the private plugin. */
export async function writeClaudeAgent(
  env: Env,
  entry: AgentEntry,
  role: AgentRole,
): Promise<ClaudeAgentTarget | undefined> {
  const target = await claudeAgentTarget(env, entry);
  const root = pluginRoot(env);
  if (!target || !root) return undefined;
  await writePluginManifests(root);
  // A linked file elsewhere in the plugin (e.g. an older name) is replaced by this one.
  for (const file of linkedClaudeAgents(await scanClaudeAgents(env), entry)) {
    if (file.plugin && file.path !== target.path)
      await removeFile(file.path, pluginAgentsDir(root));
  }
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, claudeAgentMarkdown(entry, target.name, role));
  return target;
}

/** Deletes a file and the folders it leaves empty, up to (not including) `stop`. */
async function removeFile(path: string, stop: string) {
  await rm(path, { force: true });
  for (
    let dir = dirname(path);
    dir !== stop && !relative(stop, dir).startsWith("..");
    dir = dirname(dir)
  ) {
    if (
      !(await rmdir(dir).then(
        () => true,
        () => false,
      ))
    )
      break;
  }
}

/** Deletes the agent files linked to this saved agent (plugin and ~/.claude/agents) and empty folders. */
export async function removeClaudeAgents(
  env: Env,
  entry: AgentEntry,
): Promise<ClaudeAgentFile[]> {
  const root = pluginRoot(env);
  const linked = linkedClaudeAgents(await scanClaudeAgents(env), entry);
  for (const file of linked) {
    if (file.plugin && root) await removeFile(file.path, pluginAgentsDir(root));
    else if (env.HOME) {
      // Older layout: prune up to and including ~/.claude/agents/spider, never above it.
      const legacy = legacyAgentsDir(env.HOME);
      await removeFile(
        file.path,
        file.path.startsWith(join(legacy, "spider") + sep)
          ? legacy
          : dirname(file.path),
      );
    }
  }
  return linked;
}
