import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "@repo/api/src/app";
import { createAuth } from "@repo/api/src/auth";
import { loadEnv } from "@repo/api/src/env";
import type { Mailer } from "@repo/api/src/mailer";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli";

// Runs the CLI against the real API app (no network), with a fresh org, project and agent key.

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDb = databaseUrl ? describe : describe.skip;

withDb("spider CLI against the API", () => {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  });
  const links = new Map<string, string>();
  const mailer: Mailer = {
    async sendMagicLink(email, url) {
      links.set(email, url);
    },
  };
  const db = createDb(env.DATABASE_URL);
  const app = createApp({ db, auth: createAuth(db, env, mailer), env });

  const stamp = Date.now();
  const ownerEmail = `cli-owner-${stamp}@example.com`;
  const slug = `cli-${stamp}`;
  let token = "";
  let agentId = "";
  const repo = mkdtempSync(join(tmpdir(), "spider-cli-"));

  afterAll(async () => {
    rmSync(repo, { recursive: true, force: true });
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.email, ownerEmail));
    await db.$client.end();
  });

  async function spider(...argv: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await run(argv, {
      env: { SPIDER_TOKEN: token, SPIDER_API_URL: env.API_ORIGIN },
      fetch: (input, init) => app.request(input, init),
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s) },
      cwd: repo,
    });
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
  }

  test("owner sets up a project and an agent key", async () => {
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: ownerEmail, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const verify = await app.request(link.pathname + link.search, { redirect: "manual" });
    const cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const post = async <T = unknown>(path: string, body: unknown) => {
      const res = await app.request(path, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    };

    await post("/v1/organizations", { name: "CLI Org", slug });
    await post(`/v1/orgs/${slug}/projects`, { name: "Spider", key: "SPI" });
    const agent = await post<{ actor: { id: string } }>(`/v1/orgs/${slug}/agents`, { name: "CLI Bot" });
    agentId = agent.actor.id;
    const key = await post<{ secret: string }>(`/v1/orgs/${slug}/agents/${agentId}/keys`, { name: "cli" });
    token = key.secret;
    expect(token).toStartWith("spt_");
  });

  test("whoami and projects", async () => {
    const who = await spider("whoami", "--json");
    expect(who.code).toBe(0);
    expect(who.json()).toMatchObject({ actor: { id: agentId }, organization: { slug } });
    expect((await spider("projects")).stdout).toBe("SPI  Spider\n");
  });

  test("create → list → start (from the branch) → done, recorded as source cli", async () => {
    const created = await spider(
      "task",
      "create",
      "--project",
      "spi",
      "--title",
      "Ship the CLI",
      "--description",
      "v1",
      "--priority",
      "2",
      "--json",
    );
    expect(created.code).toBe(0);
    const task = created.json();
    expect(task).toMatchObject({ key: "SPI-1", title: "Ship the CLI", priority: 2, status: { category: "todo" } });
    expect((await spider("task", "create", "--project", "SPI", "--title", "Other", "--assign", "me")).code).toBe(0);

    const mine = await spider("task", "list", "--mine", "--json");
    expect((mine.json().items as { key: string }[]).map((t) => t.key)).toEqual(["SPI-2"]);
    const backlog = await spider("task", "list", "--project", "SPI", "--status", "todo", "--limit", "1", "--json");
    expect((backlog.json().items as unknown[]).length).toBe(1);

    // No key: the CLI takes it from the branch name.
    Bun.spawnSync({ cmd: ["git", "init", "-q", "-b", "spi-1-ship-cli"], cwd: repo });
    const started = await spider("task", "start", "--json");
    expect(started.code).toBe(0);
    expect(started.json()).toMatchObject({
      key: "SPI-1",
      status: { category: "in_progress" },
      assigneeIds: [agentId],
      assignees: ["cli-bot"],
    });

    const done = await spider("task", "done", "SPI-1", "--json");
    expect(done.json()).toMatchObject({ key: "SPI-1", status: { category: "done" } });
    expect(done.json().completedAt).not.toBeNull();

    const log = await db.select().from(schema.activity).where(eq(schema.activity.entityId, task.id as string));
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(new Set(log.map((e) => e.source))).toEqual(new Set(["cli"]));

    expect((await spider("task", "view", "SPI-99")).code).toBe(3);
    expect((await spider("task", "update", "SPI-1", "--assign", "nobody")).code).toBe(2);
  });
  test("login through the browser, use the saved key, then logout", async () => {
    // A fresh sign-in for the person approving in the "browser".
    await app.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: ownerEmail, callbackURL: `${env.WEB_ORIGIN}/` }),
    });
    const link = new URL(links.get(ownerEmail) ?? "");
    const cookie = (await app.request(link.pathname + link.search, { redirect: "manual" })).headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const configDir = mkdtempSync(join(tmpdir(), "spider-config-"));
    const loginEnv = { SPIDER_API_URL: env.API_ORIGIN, SPIDER_CONFIG_DIR: configDir };
    const as = async (argv: string[], extra: Partial<Parameters<typeof run>[1]> = {}) => {
      let stdout = "";
      let stderr = "";
      const code = await run(argv, {
        env: loginEnv,
        fetch: (input, init) => app.request(input, init),
        stdout: { write: (s: string) => (stdout += s) },
        stderr: { write: (s: string) => (stderr += s) },
        cwd: repo,
        ...extra,
      });
      return { code, stdout, stderr };
    };

    let opened = "";
    let approved = false;
    const login = await as(["login", "--name", "Test Box", "--json"], {
      openUrl: (url) => (opened = url),
      // The first wait is when the person approves in the browser.
      sleep: async () => {
        if (approved) return;
        const userCode = new URL(opened).searchParams.get("code") ?? "";
        const res = await app.request(`/v1/device/${userCode}/approve`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ orgSlug: slug }),
        });
        expect(res.status).toBe(204);
        approved = true;
        await db.update(schema.deviceCodes).set({ lastPolledAt: null });
      },
    });
    expect(login.code).toBe(0);
    expect(login.stderr).toContain("confirm the code");
    expect(JSON.parse(login.stdout)).toMatchObject({ actor: { name: "spider CLI · Test Box" }, organization: { slug } });

    const file = join(configDir, "credentials.json");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");

    const who = await as(["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ actor: { handle: "cli-test-box" } });

    const { token: saved } = JSON.parse(readFileSync(file, "utf8")) as { token: string };
    expect((await as(["logout"])).stdout).toBe("Signed out @cli-test-box\n");
    expect(existsSync(file)).toBe(false);
    expect((await app.request("/v1/whoami", { headers: { Authorization: `Bearer ${saved}` } })).status).toBe(401);
    expect((await as(["whoami"])).code).toBe(4);
    rmSync(configDir, { recursive: true, force: true });
  });
});
