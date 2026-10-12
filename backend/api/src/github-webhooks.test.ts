import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GITHUB_WEBHOOK_MAX_BYTES,
  createAgent,
  createApiKey,
  createOrganization,
  createProject,
  createRepo,
  createTask,
  listRepos,
  saveGithubInstallation,
  type ActorContext,
} from "@repo/core";
import { createDb, schema } from "@repo/db";
import { createClient } from "@repo/sdk";
import { eq, inArray } from "drizzle-orm";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { createFakeGithub } from "./github-fake";
import type { Mailer } from "./mailer";

const databaseUrl = process.env.TEST_DATABASE_URL;
const SECRET = "webhook-secret";

const baseEnv = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgres://localhost:5432/unused",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
};

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const githubVars = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "spider-tracker-test",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
  GITHUB_APP_WEBHOOK_SECRET: SECRET,
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
};

const mailer: Mailer = { async sendMagicLink() {} };
const env = loadEnv({ ...baseEnv, ...githubVars });
const db = createDb(env.DATABASE_URL);
const app = createApp({ db, auth: createAuth(db, env, mailer), env, github: createFakeGithub() });
const plainEnv = loadEnv(baseEnv);
const plainApp = createApp({ db, auth: createAuth(db, plainEnv, mailer), env: plainEnv });

afterAll(() => db.$client.end());

const sign = (body: string | Uint8Array, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const deliveries: string[] = [];
const newDelivery = () => {
  const id = crypto.randomUUID();
  deliveries.push(id);
  return id;
};

function post(
  body: string,
  { event = "ping", delivery = newDelivery(), signature = sign(body), target = app }: { event?: string; delivery?: string; signature?: string | null; target?: typeof app } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": delivery };
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  return target.request("/webhooks/github", { method: "POST", headers, body });
}

const ping = JSON.stringify({ zen: "Mind your words, they are important.", hook_id: 1, hook: { type: "App" } });

describe("POST /webhooks/github without the App", () => {
  test("answers 503 not_configured, like the other GitHub routes", async () => {
    const res = await post(ping, { target: plainApp });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "not_configured" } });
  });
});

describe("POST /webhooks/github: signature and size (ST-83)", () => {
  test("a missing, wrong or other-secret signature is 401", async () => {
    for (const signature of [null, "", "sha256=00", sign(ping, "another-secret"), sign(ping).replace("sha256=", "sha1=")]) {
      const res = await post(ping, { signature });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  test("the same JSON with other whitespace fails the signature", async () => {
    const reformatted = JSON.stringify(JSON.parse(ping), null, 2);
    expect((await post(reformatted, { signature: sign(ping) })).status).toBe(401);
    expect((await post(`${ping}\n`, { signature: sign(ping) })).status).toBe(401);
  });

  test("bodies over the limit are 413, before the signature is checked", async () => {
    const big = JSON.stringify({ zen: "x".repeat(GITHUB_WEBHOOK_MAX_BYTES) });
    const res = await post(big, { signature: "sha256=00" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });
});

const withDb = databaseUrl ? describe : describe.skip;

withDb("POST /webhooks/github: deliveries (ST-83)", () => {
  const stamp = Date.now();
  const slug = `gh-hook-api-${stamp}`;
  const userId = `test-${crypto.randomUUID()}`;
  const installationId = stamp + 200;
  let owner: ActorContext;

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(db, { id: userId, name: "Owner", email: "o@example.com" }, { name: "Hook API", slug });
    owner = { orgId: created.organization.id, actorId: created.actor.id, role: "owner", source: "ui" };
    await saveGithubInstallation(db, owner, {
      installation: { id: installationId, account: "acme", accountType: "Organization", repositorySelection: "selected", suspended: false },
      repositories: [],
    });
  });

  afterAll(async () => {
    await db.delete(schema.githubDeliveries).where(inArray(schema.githubDeliveries.id, deliveries));
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  test("a signed ping is 200 and recorded", async () => {
    const delivery = newDelivery();
    const res = await post(ping, { delivery });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    const [row] = await db.select().from(schema.githubDeliveries).where(eq(schema.githubDeliveries.id, delivery));
    expect(row).toMatchObject({ event: "ping", result: "ignored" });
  });

  test("missing headers and bodies that aren't JSON are 400", async () => {
    expect((await post(ping, { delivery: "" })).status).toBe(400);
    expect((await post(ping, { event: "" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
  });

  test("parallel copies of a delivery are processed once", async () => {
    const body = JSON.stringify({
      action: "added",
      installation: { id: installationId, account: { login: "acme" } },
      repository_selection: "selected",
      repositories_added: [{ id: 1, name: "web", full_name: "acme/web", private: true }],
      repositories_removed: [],
    });
    const delivery = newDelivery();
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(body, { event: "installation_repositories", delivery })));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const statuses = await Promise.all(responses.map(async (r) => ((await r.json()) as { status: string }).status));
    expect(statuses.sort()).toEqual(["duplicate", "duplicate", "duplicate", "processed"]);
    expect((await listRepos(db, owner)).map((r) => [r.fullName, r.githubInstallationId])).toEqual([["acme/web", installationId]]);
  });
});

withDb("GitHub links on tasks (ST-84)", () => {
  const stamp = Date.now();
  const slug = `gh-links-api-${stamp}`;
  const userId = `test-${crypto.randomUUID()}`;
  const installationId = stamp + 300;
  let token = "";

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(db, { id: userId, name: "Owner", email: "o@example.com" }, { name: "Links API", slug });
    const owner: ActorContext = { orgId: created.organization.id, actorId: created.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createTask(db, owner, "ST", { title: "Ship it" });
    await createRepo(db, owner, { url: "acme/web", projects: ["ST"] });
    await saveGithubInstallation(db, owner, {
      installation: { id: installationId, account: "acme", accountType: "Organization", repositorySelection: "selected", suspended: false },
      repositories: [{ owner: "acme", name: "web", defaultBranch: "main" }],
    });
    const agent = await createAgent(db, owner, { name: "Reader" });
    token = (await createApiKey(db, owner, agent.actor.id, { name: "test" })).secret;
  });

  afterAll(async () => {
    await db.delete(schema.githubDeliveries).where(inArray(schema.githubDeliveries.id, deliveries));
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  test("signed push and pull_request events link to the task; GET /tasks/:key/git lists them", async () => {
    const installation = { id: installationId };
    const repository = { name: "web", owner: { login: "acme" } };
    const push = JSON.stringify({
      ref: "refs/heads/st-1-ship-it",
      installation,
      repository,
      commits: [{ id: "f".repeat(40), message: "Start ST-1", timestamp: "2026-10-12T10:00:00Z", author: { name: "Ann", username: "ann" } }],
    });
    const pushed = await post(push, { event: "push" });
    expect(await pushed.json()).toEqual({ status: "processed" });
    const pr = JSON.stringify({
      action: "opened",
      number: 3,
      installation,
      repository,
      pull_request: {
        number: 3,
        title: "Ship it",
        body: "Fixes ST-1",
        state: "open",
        draft: false,
        merged: false,
        updated_at: "2026-10-12T11:00:00Z",
        head: { ref: "st-1-ship-it" },
        base: { ref: "main" },
        user: { login: "ann" },
      },
    });
    expect(await (await post(pr, { event: "pull_request" })).json()).toEqual({ status: "processed" });

    const client = createClient({ baseUrl: env.API_ORIGIN, token, fetch: (input, init) => app.request(input, init) });
    const git = await client.tasks.git(slug, "st-1");
    expect(git).toMatchObject({
      taskKey: "ST-1",
      pullRequests: [{ repo: "acme/web", number: 3, state: "open", via: "closing", url: "https://github.com/acme/web/pull/3" }],
      branches: [{ name: "st-1-ship-it", deleted: false }],
      commits: [{ sha: "f".repeat(40), message: "Start ST-1", via: "branch", author: "ann" }],
    });
    await expect(client.tasks.git(slug, "ST-99")).rejects.toMatchObject({ status: 404 });
  });
});

withDb("status automation from signed pull_request events (ST-85)", () => {
  const stamp = Date.now();
  const slug = `gh-auto-api-${stamp}`;
  const userId = `test-${crypto.randomUUID()}`;
  const installationId = stamp + 400;
  let token = "";

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(db, { id: userId, name: "Owner", email: "o@example.com" }, { name: "Automation API", slug });
    const owner: ActorContext = { orgId: created.organization.id, actorId: created.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createTask(db, owner, "ST", { title: "Ship it" });
    await createRepo(db, owner, { url: "acme/web", projects: ["ST"] });
    await saveGithubInstallation(db, owner, {
      installation: { id: installationId, account: "acme", accountType: "Organization", repositorySelection: "selected", suspended: false },
      repositories: [{ owner: "acme", name: "web", defaultBranch: "main" }],
    });
    const agent = await createAgent(db, owner, { name: "Reader" });
    token = (await createApiKey(db, owner, agent.actor.id, { name: "test" })).secret;
  });

  afterAll(async () => {
    await db.delete(schema.githubDeliveries).where(inArray(schema.githubDeliveries.id, deliveries));
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  });

  test("opened → In Review, merged → Done, with no manual step", async () => {
    const client = createClient({ baseUrl: env.API_ORIGIN, token, fetch: (input, init) => app.request(input, init) });
    const project = await client.projects.get(slug, "ST");
    const statusName = async () => {
      const { statusId } = await client.tasks.get(slug, "ST-1");
      return project.statuses.find((s) => s.id === statusId)?.name;
    };
    expect(project.gitAutomation).toEqual({ enabled: true, draft: "in_progress", opened: "in_review", merged: "done", closed: null });
    expect(await statusName()).toBe("Todo");

    const event = (action: string, fields: Record<string, unknown>) =>
      JSON.stringify({
        action,
        number: 5,
        installation: { id: installationId },
        repository: { name: "web", owner: { login: "acme" }, default_branch: "main" },
        sender: { login: "ann", type: "User" },
        pull_request: {
          number: 5,
          title: "Ship it",
          body: "Fixes ST-1",
          state: "open",
          draft: false,
          merged: false,
          head: { ref: "st-1-ship-it", repo: { full_name: "acme/web" } },
          base: { ref: "main" },
          user: { login: "ann", type: "User" },
          author_association: "MEMBER",
          ...fields,
        },
      });

    const opened = await post(event("opened", { updated_at: "2026-10-12T11:00:00Z" }), { event: "pull_request" });
    expect(await opened.json()).toEqual({ status: "processed" });
    expect(await statusName()).toBe("In Review");

    const merged = event("closed", {
      state: "closed",
      merged: true,
      merged_at: "2026-10-12T12:00:00Z",
      closed_at: "2026-10-12T12:00:00Z",
      updated_at: "2026-10-12T12:00:00Z",
    });
    const delivery = newDelivery();
    expect(await (await post(merged, { event: "pull_request", delivery })).json()).toEqual({ status: "processed" });
    const done = await client.tasks.get(slug, "ST-1");
    expect(await statusName()).toBe("Done");
    expect(done.completedAt).not.toBeNull();

    // The moves are the @github bot's, from source git.
    const activity = await client.tasks.activity(slug, "ST-1");
    const moves = activity.items.filter((a) => a.action === "task.updated");
    expect(moves.map((a) => a.source)).toEqual(["git", "git"]);

    // GitHub redelivering the merge (same delivery id) changes nothing more.
    const again = await post(merged, { event: "pull_request", delivery });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    const after = await client.tasks.activity(slug, "ST-1");
    expect(after.items.filter((a) => a.action === "task.updated").length).toBe(2);
    expect(await statusName()).toBe("Done");
  });
});
