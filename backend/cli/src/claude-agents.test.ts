import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  claudeAgentFor,
  claudeAgentTarget,
  removeClaudeAgents,
} from "./claude-agents";
import type { AgentEntry } from "./credentials";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function home(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "spider-claude-agents-"));
  homes.push(dir);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, ".claude", "agents", path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
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
  test("finds a linked agent in a subfolder, and a plain top-level one by handle", async () => {
    const dir = home({
      "spider/local/batele/reviewer.md": agentFile(
        "local-reviewer",
        "local/batele/reviewer",
      ),
      "builder.md": agentFile("builder"),
      "other.md": agentFile("other", "prod/batele/other"),
    });
    expect(
      await claudeAgentFor(dir, entry("local", "batele", "reviewer")),
    ).toBe("local-reviewer");
    expect(await claudeAgentFor(dir, entry("prod", "batele", "builder"))).toBe(
      "builder",
    );
    expect(
      await claudeAgentFor(dir, entry("prod", "batele", "nobody")),
    ).toBeUndefined();
  });

  test("targets spider/<server>/<org>/<handle>.md with a name no other agent uses", async () => {
    const dir = home({
      "spider/prod/batele/reviewer.md": agentFile(
        "reviewer",
        "prod/batele/reviewer",
      ),
    });
    const prod = await claudeAgentTarget(
      dir,
      entry("prod", "batele", "reviewer"),
    );
    // Its own file doesn't count as taken.
    expect(prod).toEqual({
      path: join(
        dir,
        ".claude",
        "agents",
        "spider",
        "prod",
        "batele",
        "reviewer.md",
      ),
      name: "reviewer",
    });
    const local = await claudeAgentTarget(
      dir,
      entry("local", "batele", "reviewer"),
    );
    expect(local?.name).toBe("local-reviewer");
    expect(local?.path).toBe(
      join(
        dir,
        ".claude",
        "agents",
        "spider",
        "local",
        "batele",
        "reviewer.md",
      ),
    );
  });

  test("removes only linked files and prunes empty spider folders", async () => {
    const dir = home({
      "spider/local/batele/reviewer.md": agentFile(
        "local-reviewer",
        "local/batele/reviewer",
      ),
      "reviewer.md": agentFile("reviewer"),
      "spider/prod/batele/builder.md": agentFile(
        "builder",
        "prod/batele/builder",
      ),
    });
    const deleted = await removeClaudeAgents(
      dir,
      entry("local", "batele", "reviewer"),
    );
    const agents = join(dir, ".claude", "agents");
    expect(deleted).toEqual([
      join(agents, "spider", "local", "batele", "reviewer.md"),
    ]);
    expect(existsSync(join(agents, "spider", "local"))).toBe(false);
    expect(existsSync(join(agents, "reviewer.md"))).toBe(true);
    expect(
      existsSync(join(agents, "spider", "prod", "batele", "builder.md")),
    ).toBe(true);

    await removeClaudeAgents(dir, entry("prod", "batele", "builder"));
    expect(existsSync(join(agents, "spider"))).toBe(false);
    expect(existsSync(agents)).toBe(true);
  });
});
