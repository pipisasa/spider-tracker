import { readFile, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AgentEntry } from "./credentials";

// Claude Code agents (~/.claude/agents/**/*.md) that belong to saved Spider agents. Claude Code
// finds an agent by its frontmatter `name` in any subfolder, so ours live in
// spider/<server>/<org>/<handle>.md and point back with `spider-agent: <server/org/handle>`.

export interface ClaudeAgentFile {
  path: string;
  name: string;
  spider?: string;
}

const agentsDir = (home: string) => join(home, ".claude", "agents");

/** Every agent file under ~/.claude/agents, subfolders included, in path order. */
export async function scanClaudeAgents(
  home: string | undefined,
): Promise<ClaudeAgentFile[]> {
  if (!home) return [];
  const dir = agentsDir(home);
  const names = await readdir(dir, { recursive: true }).then(
    (all) => all.filter((n) => n.endsWith(".md")).sort(),
    () => [] as string[],
  );
  return Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const text = await readFile(path, "utf8").catch(() => "");
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      const field = (key: string) =>
        new RegExp(`^${key}:[ \\t]*["']?(.*?)["']?[ \\t]*$`, "m").exec(
          front,
        )?.[1] || undefined;
      const base = name.split(/[\\/]/).pop() ?? name;
      return {
        path,
        name: field("name") ?? base.slice(0, -3),
        spider: field("spider-agent"),
      };
    }),
  );
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
 * The Claude Code agent to start with a saved agent: a linked file, else a top-level
 * `<handle>.md` that isn't linked to another Spider agent.
 */
export async function claudeAgentFor(
  home: string | undefined,
  entry: AgentEntry,
): Promise<string | undefined> {
  const files = await scanClaudeAgents(home);
  const linked = linkedClaudeAgents(files, entry)[0];
  if (linked) return linked.name;
  if (!home) return undefined;
  const plain = files.find(
    (f) => f.path === join(agentsDir(home), `${entry.agent}.md`) && !f.spider,
  );
  return plain?.name;
}

/**
 * Where a new Claude Code agent for this saved agent goes, and a `name` no other agent file uses
 * (names must be unique across all folders): the handle, else server-handle, else server-org-handle.
 */
export async function claudeAgentTarget(
  home: string | undefined,
  entry: AgentEntry,
): Promise<{ path: string; name: string } | undefined> {
  if (!home) return undefined;
  const files = await scanClaudeAgents(home);
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
    candidates.find((c) => !taken.has(c)) ?? candidates[candidates.length - 1];
  return {
    path: join(
      agentsDir(home),
      "spider",
      entry.server,
      entry.org,
      `${entry.agent}.md`,
    ),
    name,
  };
}

/** Deletes the agent files linked to this saved agent and any spider/ folders left empty. */
export async function removeClaudeAgents(
  home: string | undefined,
  entry: AgentEntry,
): Promise<string[]> {
  if (!home) return [];
  const root = join(agentsDir(home), "spider");
  const linked = linkedClaudeAgents(await scanClaudeAgents(home), entry);
  for (const file of linked) {
    await rm(file.path, { force: true });
    // Prune empty folders up to (and including) spider/, never above it.
    for (
      let dir = dirname(file.path);
      !relative(root, dir).startsWith("..");
      dir = dirname(dir)
    ) {
      if (
        !(await rmdir(dir).then(
          () => true,
          () => false,
        ))
      )
        break;
      if (dir === root) break;
    }
  }
  return linked.map((f) => f.path);
}
