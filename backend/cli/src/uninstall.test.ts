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
import { run, type RunOptions } from "./cli";
import type { Store } from "./credentials";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

/** A machine with two saved agents, both plugins' files, a legacy agent file and an installed binary. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), "spider-uninstall-"));
  homes.push(home);
  const config = join(home, ".config", "spider-tracker");
  const write = (path: string, body = "x") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  const saved = (handle: string, token: string) => ({
    token,
    actor: { name: handle, handle },
    projects: null,
    source: "invite" as const,
    createdAt: "",
  });
  const store: Store = {
    version: 2,
    servers: {
      prod: {
        url: "https://api.test",
        orgs: {
          acme: { name: "Acme", agents: { dev: saved("dev", "spt_dev") } },
        },
      },
      local: {
        url: "http://localhost:4000",
        orgs: { acme: { name: "Acme", agents: { qa: saved("qa", "spt_qa") } } },
      },
    },
  };
  write(join(config, "credentials.json"), JSON.stringify(store));
  write(
    join(
      config,
      "claude-plugin",
      "spider-agents",
      "agents",
      "prod",
      "acme",
      "dev.md",
    ),
    "---\nname: dev\nspider-agent: prod/acme/dev\n---\n",
  );
  write(
    join(
      home,
      ".claude",
      "plugins",
      "cache",
      "spider-tracker",
      "0.3.1",
      "plugin.json",
    ),
  );
  write(
    join(
      home,
      ".claude",
      "plugins",
      "cache",
      "spider-local",
      "spider-agents",
      "plugin.json",
    ),
  );
  write(
    join(home, ".claude", "plugins", "cache", "other-plugin", "plugin.json"),
  );
  write(
    join(home, ".claude", "agents", "spider", "prod", "acme", "old.md"),
    "---\nname: old\nspider-agent: prod/acme/dev\n---\n",
  );
  write(join(home, ".claude", "agents", "mine.md"), "---\nname: mine\n---\n");
  const binary = join(home, ".local", "bin", "spider");
  write(binary, "#!/bin/sh\n");
  return { home, config, binary, env: { HOME: home } };
}

async function uninstall(argv: string[], options: Partial<RunOptions>) {
  let stdout = "";
  let stderr = "";
  const revoked: string[] = [];
  const claude: string[][] = [];
  const code = await run(["uninstall", ...argv], {
    env: {},
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    fetch: (input: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("Authorization") ?? "";
      if (
        init.method === "DELETE" &&
        new URL(input).pathname === "/v1/api-keys/current"
      ) {
        revoked.push(`${new URL(input).origin} ${auth}`);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(
        Response.json(
          { error: { code: "not_found", message: "no" } },
          { status: 404 },
        ),
      );
    },
    runClaude: (args: string[]) => {
      claude.push(args);
      return Promise.resolve({ exitCode: 0, output: "" });
    },
    ...options,
  });
  return { code, stdout, stderr, revoked, claude };
}

describe("spider uninstall", () => {
  test("without --yes and no terminal it only describes the plan", async () => {
    const m = machine();
    const result = await uninstall([], { env: m.env, binaryPath: m.binary });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "revoke the keys of prod/acme/dev, local/acme/qa",
    );
    expect(result.stderr).toContain("Re-run with --yes");
    expect(result.revoked).toEqual([]);
    expect(existsSync(m.config)).toBe(true);
    expect(existsSync(m.binary)).toBe(true);
  });

  test("--yes revokes every key, uninstalls the plugins and deletes only spider's files", async () => {
    const m = machine();
    const result = await uninstall(["--yes"], {
      env: m.env,
      binaryPath: m.binary,
    });
    expect(result.code).toBe(0);
    expect(result.revoked.sort()).toEqual([
      "http://localhost:4000 Bearer spt_qa",
      "https://api.test Bearer spt_dev",
    ]);
    expect(result.claude).toEqual([
      [
        "plugin",
        "uninstall",
        "spider-tracker@spider-tracker",
        "--scope",
        "user",
      ],
      ["plugin", "uninstall", "spider-agents@spider-local", "--scope", "user"],
      ["plugin", "marketplace", "remove", "spider-tracker"],
      ["plugin", "marketplace", "remove", "spider-local"],
    ]);
    const claude = join(m.home, ".claude");
    expect(existsSync(m.config)).toBe(false);
    expect(existsSync(m.binary)).toBe(false);
    expect(existsSync(join(claude, "plugins", "cache", "spider-tracker"))).toBe(
      false,
    );
    expect(existsSync(join(claude, "plugins", "cache", "spider-local"))).toBe(
      false,
    );
    expect(
      existsSync(join(claude, "agents", "spider", "prod", "acme", "old.md")),
    ).toBe(false);
    // Nothing that isn't spider's.
    expect(existsSync(join(claude, "plugins", "cache", "other-plugin"))).toBe(
      true,
    );
    expect(existsSync(join(claude, "agents", "mine.md"))).toBe(true);
    expect(result.stdout).toContain("spider is uninstalled.");
    expect(result.stdout).toContain("Settings → Agents");
  });

  test("--keep-keys revokes nothing; from source the command itself stays; a confirm 'no' removes nothing", async () => {
    const kept = await uninstall(["--yes", "--keep-keys", "--json"], {
      env: machine().env,
    });
    expect(kept.revoked).toEqual([]);
    const report = JSON.parse(kept.stdout) as {
      revoked: string[];
      deleted: string[];
    };
    expect(report.revoked).toEqual([]);
    expect(report.deleted.some((path) => path.endsWith("spider-tracker"))).toBe(
      true,
    );

    const m = machine();
    const declined = await uninstall([], {
      env: m.env,
      binaryPath: m.binary,
      confirm: () => Promise.resolve(false),
    });
    expect(declined.code).toBe(0);
    expect(declined.stderr).toContain("Nothing removed.");
    expect(existsSync(m.config)).toBe(true);
  });

  test("a key that can't be revoked is reported and the rest still goes; no Claude Code is fine", async () => {
    const m = machine();
    const result = await uninstall(["--yes"], {
      env: m.env,
      runClaude: () => Promise.resolve(undefined),
      fetch: (input: string) =>
        new URL(input).hostname === "localhost"
          ? Promise.reject(new Error("connection refused"))
          : Promise.resolve(new Response(null, { status: 204 })),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Couldn't revoke local/acme/qa");
    expect(result.stdout).toContain("Claude Code isn't installed");
    expect(existsSync(m.config)).toBe(false);
  });
});
