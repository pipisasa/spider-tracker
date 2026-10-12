import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  claudeAgentFor,
  claudeAgentTarget,
  removeClaudeAgents,
  writeClaudeAgent,
} from "./claude-agents";
import type { AgentEntry } from "./credentials";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

/** A temp HOME with files under ~/.claude/agents (legacy) and the private plugin's agents/. */
function setup(
  legacy: Record<string, string>,
  plugin: Record<string, string> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "spider-claude-agents-"));
  homes.push(home);
  const env = { HOME: home, SPIDER_CONFIG_DIR: join(home, "config") };
  const agents = join(
    env.SPIDER_CONFIG_DIR,
    "claude-plugin",
    "spider-agents",
    "agents",
  );
  const write = (dir: string, files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
  };
  write(join(home, ".claude", "agents"), legacy);
  write(agents, plugin);
  return { home, env, agents, legacy: join(home, ".claude", "agents") };
}

const agentFile = (name: string, spider?: string) =>
  `---\nname: ${name}\ndescription: test\n${spider ? `spider-agent: ${spider}\n` : ""}---\nbody\n`;

function entry(server: string, org: string, agent: string): AgentEntry {
  return {
    server,
    org,
    agent,
    ref: `${server}/${org}/${agent}`,
    serverUrl: "http://localhost:4000",
    orgName: org,
    saved: {
      token: "spt_x",
      actor: { name: agent, handle: agent },
      projects: null,
      source: "invite",
      createdAt: "",
    },
  };
}

describe("Claude Code agents for saved agents", () => {
  test("finds plugin agents by qualified name, then legacy linked and plain ones", async () => {
    const { env } = setup(
      {
        "spider/local/batele/reviewer.md": agentFile(
          "local-reviewer",
          "local/batele/reviewer",
        ),
        "builder.md": agentFile("builder"),
        "other.md": agentFile("other", "prod/batele/other"),
      },
      { "prod/batele/writer.md": agentFile("writer", "prod/batele/writer") },
    );
    expect(await claudeAgentFor(env, entry("prod", "batele", "writer"))).toBe(
      "spider-agents:prod:batele:writer",
    );
    expect(
      await claudeAgentFor(env, entry("local", "batele", "reviewer")),
    ).toBe("local-reviewer");
    expect(await claudeAgentFor(env, entry("prod", "batele", "builder"))).toBe(
      "builder",
    );
    expect(
      await claudeAgentFor(env, entry("prod", "batele", "nobody")),
    ).toBeUndefined();
  });

  test("targets the plugin's <server>/<org>/<handle>.md with a name no other agent uses", async () => {
    const { env, agents } = setup(
      { "reviewer.md": agentFile("reviewer") },
      { "prod/batele/writer.md": agentFile("writer", "prod/batele/writer") },
    );
    // Its own file doesn't count as taken.
    expect(
      await claudeAgentTarget(env, entry("prod", "batele", "writer")),
    ).toEqual({
      plugin: "spider-agents",
      name: "writer",
      path: join(agents, "prod", "batele", "writer.md"),
      qualifiedName: "spider-agents:prod:batele:writer",
    });
    const local = await claudeAgentTarget(
      env,
      entry("local", "batele", "reviewer"),
    );
    expect(local?.name).toBe("local-reviewer");
    expect(local?.qualifiedName).toBe(
      "spider-agents:local:batele:local-reviewer",
    );
  });

  test("writes the agent file and the plugin manifests", async () => {
    const { env, agents } = setup({});
    const written = await writeClaudeAgent(env, entry("prod", "acme", "bot"), {
      description: "Reviews: pull requests",
      prompt: "You review code.",
      projects: [{ key: "ST", name: "Spider" }],
    });
    expect(written?.path).toBe(join(agents, "prod", "acme", "bot.md"));
    const text = readFileSync(written?.path ?? "", "utf8");
    expect(text).toStartWith(
      '---\nname: bot\ndescription: "Reviews: pull requests"\nspider-agent: prod/acme/bot\n---\n\nYou review code.\n\n## Spider Tracker\n',
    );
    expect(text).toContain("working in: ST (Spider)");
    expect(text).toContain("spider … --as bot --json");
    const root = join(env.SPIDER_CONFIG_DIR, "claude-plugin");
    expect(
      JSON.parse(
        readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
      ),
    ).toMatchObject({
      name: "spider-local",
      plugins: [{ name: "spider-agents", source: "./spider-agents" }],
    });
    expect(
      JSON.parse(
        readFileSync(
          join(root, "spider-agents", ".claude-plugin", "plugin.json"),
          "utf8",
        ),
      ).name,
    ).toBe("spider-agents");
  });

  test("removes only linked files, from the plugin and ~/.claude/agents, pruning empty folders", async () => {
    const { env, agents, legacy } = setup(
      {
        "spider/local/batele/reviewer.md": agentFile(
          "local-reviewer",
          "local/batele/reviewer",
        ),
        "reviewer.md": agentFile("reviewer"),
      },
      {
        "local/batele/reviewer.md": agentFile(
          "reviewer",
          "local/batele/reviewer",
        ),
        "prod/batele/builder.md": agentFile("builder", "prod/batele/builder"),
      },
    );
    const deleted = await removeClaudeAgents(
      env,
      entry("local", "batele", "reviewer"),
    );
    expect(deleted.map((f) => f.path)).toEqual([
      join(agents, "local", "batele", "reviewer.md"),
      join(legacy, "spider", "local", "batele", "reviewer.md"),
    ]);
    expect(existsSync(join(agents, "local"))).toBe(false);
    expect(existsSync(join(legacy, "spider"))).toBe(false);
    expect(existsSync(join(legacy, "reviewer.md"))).toBe(true);
    expect(existsSync(join(agents, "prod", "batele", "builder.md"))).toBe(true);

    await removeClaudeAgents(env, entry("prod", "batele", "builder"));
    expect(existsSync(join(agents, "prod"))).toBe(false);
    expect(existsSync(agents)).toBe(true);
  });
});
