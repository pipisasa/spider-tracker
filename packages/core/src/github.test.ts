import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { addComment } from "./comments";
import {
  GITHUB_INSTALL_STATE_TTL_MS,
  GithubInstallationTakenError,
  createGithubInstallState,
  disconnectGithubInstallation,
  githubBotContext,
  githubInstallationSettingsUrl,
  listGithubInstallations,
  resolveGithubSetup,
  saveGithubInstallation,
  signGithubInstallState,
  verifyGithubInstallState,
  type GithubInstallationData,
} from "./github";
import { handleFrom } from "./handles";
import { createOrganization, listMembers } from "./organizations";
import { createProject, getProject } from "./projects";
import { attachRepo, createRepo, getRepo, listRepos } from "./repos";
import { createAgentInput } from "./schemas";
import { createTask } from "./tasks";

const SECRET = "test-secret-test-secret-test-secret-123";

describe("GitHub install state (ST-82)", () => {
  const now = 1_800_000_000_000;

  test("round-trips the organization and person until it expires", () => {
    const state = signGithubInstallState(SECRET, { orgId: "org-1", userId: "user-1" }, now);
    expect(verifyGithubInstallState(SECRET, state, now + 1000)).toEqual({
      orgId: "org-1",
      userId: "user-1",
      expiresAt: now + GITHUB_INSTALL_STATE_TTL_MS,
      nonce: expect.any(String),
    });
    expect(verifyGithubInstallState(SECRET, state, now + GITHUB_INSTALL_STATE_TTL_MS)).toBeNull();
  });

  test("each state is different (a nonce)", () => {
    const a = signGithubInstallState(SECRET, { orgId: "o", userId: "u" }, now);
    const b = signGithubInstallState(SECRET, { orgId: "o", userId: "u" }, now);
    expect(a).not.toBe(b);
  });

  test("refuses another secret, a changed payload and malformed values", () => {
    const state = signGithubInstallState(SECRET, { orgId: "org-1", userId: "user-1" }, now);
    expect(verifyGithubInstallState(`${SECRET}x`, state, now)).toBeNull();
    const [payload, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "org-2", u: "user-1", e: now + 60_000, n: "x" })).toString("base64url");
    expect(verifyGithubInstallState(SECRET, `${forged}.${signature}`, now)).toBeNull();
    expect(verifyGithubInstallState(SECRET, `${payload}.`, now)).toBeNull();
    expect(verifyGithubInstallState(SECRET, `${state}.x`, now)).toBeNull();
    expect(verifyGithubInstallState(SECRET, "", now)).toBeNull();
    expect(verifyGithubInstallState(SECRET, "not-a-state", now)).toBeNull();
  });

  test("settings links differ for users and organizations", () => {
    expect(githubInstallationSettingsUrl({ id: 7, accountLogin: "acme", accountType: "Organization" })).toBe(
      "https://github.com/organizations/acme/settings/installations/7",
    );
    expect(githubInstallationSettingsUrl({ id: 7, accountLogin: "jane", accountType: "User" })).toBe(
      "https://github.com/settings/installations/7",
    );
  });

  test('"github" is reserved for the bot', () => {
    expect(handleFrom("github@example.com")).toBe("github-1");
    expect(createAgentInput.safeParse({ name: "x", handle: "github" }).success).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("GitHub installations (ST-82)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const stamp = Date.now();
  const slugs = [`gh-${stamp}`, `gh-other-${stamp}`];
  const people: string[] = [];
  // GitHub ids are global: unique per run.
  const installationId = stamp;
  const otherInstallationId = stamp + 1;
  let owner: ActorContext;
  let other: ActorContext;
  let member: ActorContext;
  let ownersAgent: ActorContext;
  let opsAgent: ActorContext;

  const installation = (patch: Partial<GithubInstallationData> = {}): GithubInstallationData => ({
    id: installationId,
    account: "acme",
    accountType: "Organization",
    repositorySelection: "selected",
    suspended: false,
    ...patch,
  });

  async function addPerson(role: ActorContext["role"], handle: string): Promise<ActorContext & { userId: string }> {
    const id = `test-${crypto.randomUUID()}`;
    people.push(id);
    await db.insert(schema.user).values({ id, name: handle, email: `${id}@example.com` });
    const [actor] = await db
      .insert(schema.actors)
      .values({ orgId: owner.orgId, type: "human", userId: id, name: handle, handle, role })
      .returning();
    return { orgId: owner.orgId, actorId: actor?.id ?? "", role, source: "ui", userId: id };
  }

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const user = { id: userId, name: "Owner", email: "owner@example.com" };
    const a = await createOrganization(db, user, { name: "GitHub Org", slug: slugs[0] });
    const b = await createOrganization(db, user, { name: "Other Org", slug: slugs[1] });
    owner = { orgId: a.organization.id, actorId: a.actor.id, role: "owner", source: "ui" };
    other = { orgId: b.organization.id, actorId: b.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Ops", key: "OPS" });
    member = await addPerson("member", "member");
    const agent = await createAgent(db, owner, { name: "Owner's agent" });
    ownersAgent = { orgId: owner.orgId, actorId: agent.actor.id, role: "member", source: "mcp" };
    const ops = await createAgent(db, owner, { name: "Ops agent" });
    await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, ops.actor.id));
    const opsProject = await getProject(db, owner.orgId, "OPS");
    await db.insert(schema.agentProjects).values({ agentId: ops.actor.id, projectId: opsProject.id });
    opsAgent = { orgId: owner.orgId, actorId: ops.actor.id, role: "member", source: "mcp" };
  });

  afterAll(async () => {
    for (const slug of slugs) await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    for (const id of [userId, ...people]) await db.delete(schema.user).where(eq(schema.user.id, id));
    await db.$client.end();
  });

  test("only owners and admins start the install flow; the state names them", async () => {
    const state = await createGithubInstallState(db, owner, { secret: SECRET, userId });
    const verified = verifyGithubInstallState(SECRET, state);
    expect(verified).toMatchObject({ orgId: owner.orgId, userId });
    // Its nonce is recorded, to be used once.
    const [row] = await db.select().from(schema.githubInstallStates).where(eq(schema.githubInstallStates.nonce, verified?.nonce ?? ""));
    expect(row).toMatchObject({ orgId: owner.orgId, userId });
    await expect(createGithubInstallState(db, member, { secret: SECRET, userId })).rejects.toThrow("Your role can't connect GitHub");
  });

  test("the setup callback accepts the state only for the person who started it, while they may connect", async () => {
    const state = await createGithubInstallState(db, owner, { secret: SECRET, userId });
    const someone = await addPerson("admin", "someone");
    // Someone else's session neither uses the state nor uses it up.
    await expect(resolveGithubSetup(db, { secret: SECRET, state, userId: someone.userId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(resolveGithubSetup(db, { secret: "another-secret-another-secret-12345", state, userId })).rejects.toMatchObject({
      code: "validation",
    });
    const resolved = await resolveGithubSetup(db, { secret: SECRET, state, userId });
    expect(resolved).toEqual({ ctx: { ...owner, source: "ui" }, orgSlug: slugs[0] ?? "" });

    // Demoted after starting: refused.
    const admin = await addPerson("admin", "admin");
    const adminState = await createGithubInstallState(db, admin, { secret: SECRET, userId: admin.userId });
    await db.update(schema.actors).set({ role: "member" }).where(eq(schema.actors.id, admin.actorId));
    await expect(resolveGithubSetup(db, { secret: SECRET, state: adminState, userId: admin.userId })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  test("a state works once, even when two callbacks race (ST-137)", async () => {
    const state = await createGithubInstallState(db, owner, { secret: SECRET, userId });
    await resolveGithubSetup(db, { secret: SECRET, state, userId });
    await expect(resolveGithubSetup(db, { secret: SECRET, state, userId })).rejects.toThrow("already used");

    const raced = await createGithubInstallState(db, owner, { secret: SECRET, userId });
    const results = await Promise.allSettled([
      resolveGithubSetup(db, { secret: SECRET, state: raced, userId }),
      resolveGithubSetup(db, { secret: SECRET, state: raced, userId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);

    // Correctly signed but never issued here (no row): refused too.
    const unissued = signGithubInstallState(SECRET, { orgId: owner.orgId, userId });
    await expect(resolveGithubSetup(db, { secret: SECRET, state: unissued, userId })).rejects.toMatchObject({ code: "validation" });
  });

  test("an expired state is refused, and issuing a new one cleans up expired rows", async () => {
    const past = Date.now() - GITHUB_INSTALL_STATE_TTL_MS - 60_000;
    const state = await createGithubInstallState(db, owner, { secret: SECRET, userId });
    const old = await createGithubInstallState(db, owner, { secret: SECRET, userId, now: past });
    await expect(resolveGithubSetup(db, { secret: SECRET, state: old, userId })).rejects.toMatchObject({ code: "validation" });

    // The row's expiry is checked too, not only the signed one.
    const nonce = verifyGithubInstallState(SECRET, state)?.nonce ?? "";
    await db.update(schema.githubInstallStates).set({ expiresAt: new Date(past) }).where(eq(schema.githubInstallStates.nonce, nonce));
    await expect(resolveGithubSetup(db, { secret: SECRET, state, userId })).rejects.toMatchObject({ code: "validation" });

    const oldNonce = verifyGithubInstallState(SECRET, old, past)?.nonce ?? "";
    const rows = () => db.select().from(schema.githubInstallStates).where(inArray(schema.githubInstallStates.nonce, [nonce, oldNonce]));
    expect(await rows()).toHaveLength(2);
    await createGithubInstallState(db, owner, { secret: SECRET, userId });
    expect(await rows()).toEqual([]);
  });

  test("connecting attaches existing repos, adds the others and creates the hidden GitHub bot", async () => {
    // Added by URL before the App (ST-92), attached to ST; GitHub's casing differs.
    await createRepo(db, owner, { url: "acme/web", projects: ["ST"] });

    const dto = await saveGithubInstallation(db, owner, {
      installation: installation(),
      repositories: [
        { owner: "Acme", name: "Web", defaultBranch: "main" },
        { owner: "acme", name: "api", defaultBranch: "trunk" },
      ],
    });
    expect(dto).toMatchObject({
      id: installationId,
      account: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      repos: ["acme/api", "acme/web"],
      settingsUrl: `https://github.com/organizations/acme/settings/installations/${installationId}`,
      connectedBy: owner.actorId,
    });

    // No duplicate: the existing row got the installation and kept its projects and casing.
    const repos = await listRepos(db, owner);
    expect(repos.map((r) => [r.fullName, r.githubInstallationId, r.defaultBranch, r.projects])).toEqual([
      ["acme/api", installationId, "trunk", []],
      ["acme/web", installationId, "main", ["ST"]],
    ]);

    // The bot: an integration actor, listed only with everyone (for naming), never mentioned or assigned.
    const all = await listMembers(db, owner.orgId, { includeDeactivated: true });
    const bot = all.find((m) => m.type === "integration");
    expect(bot).toMatchObject({ handle: "github", name: "GitHub", userId: null });
    expect((await listMembers(db, owner.orgId)).some((m) => m.type === "integration")).toBe(false);
    await expect(createTask(db, owner, "ST", { title: "x", assigneeIds: [bot?.id ?? ""] })).rejects.toMatchObject({
      code: "validation",
    });
    const task = await createTask(db, owner, "ST", { title: "Mention the bot" });
    await addComment(db, owner, task.key, { body: "@github hello" });
    const inbox = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.recipientId, bot?.id ?? ""));
    expect(inbox).toEqual([]);

    // Its context for git-driven changes reuses the same actor.
    const botCtx = await db.transaction((tx) => githubBotContext(tx, owner.orgId));
    expect(botCtx).toEqual({ orgId: owner.orgId, actorId: bot?.id ?? "", role: "member", source: "git" });

    const activity = await db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.orgId, owner.orgId), eq(schema.activity.action, "github.connected")));
    expect(activity.map((a) => a.changes)).toEqual([
      { installation: installationId, account: "acme", attached: ["acme/web"], added: ["acme/api"] },
    ]);
  });

  test("a sync updates the account and releases repos the installation no longer grants", async () => {
    const dto = await saveGithubInstallation(db, ownersAgent, {
      installation: installation({ account: "acme-inc", repositorySelection: "all", suspended: true }),
      repositories: [{ owner: "acme", name: "api", defaultBranch: "trunk" }],
    });
    expect(dto).toMatchObject({ account: "acme-inc", repositorySelection: "all", suspended: true, repos: ["acme/api"] });
    // Released, not removed.
    expect((await getRepo(db, owner, "acme/web")).githubInstallationId).toBeNull();
    const [synced] = await db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.orgId, owner.orgId), eq(schema.activity.action, "github.synced")));
    expect(synced?.changes).toEqual({ installation: installationId, account: "acme-inc", released: ["acme/web"] });
    // One bot only.
    const bots = (await listMembers(db, owner.orgId, { includeDeactivated: true })).filter((m) => m.type === "integration");
    expect(bots).toHaveLength(1);
  });

  test("members and project-scoped agents can't connect; anyone reads", async () => {
    const data = { installation: installation(), repositories: [] };
    await expect(saveGithubInstallation(db, member, data)).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveGithubInstallation(db, opsAgent, data)).rejects.toMatchObject({ code: "forbidden" });
    await expect(disconnectGithubInstallation(db, member, installationId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await listGithubInstallations(db, member)).map((i) => i.id)).toEqual([installationId]);
    // A scoped agent sees only its projects' repos in it (acme/api is attached to none).
    await attachRepo(db, owner, "OPS", { repo: "acme/web" });
    await saveGithubInstallation(db, owner, {
      installation: installation(),
      repositories: [
        { owner: "acme", name: "api", defaultBranch: "trunk" },
        { owner: "acme", name: "web", defaultBranch: "main" },
      ],
    });
    expect((await listGithubInstallations(db, opsAgent)).map((i) => i.repos)).toEqual([["acme/web"]]);
  });

  test("an installation belongs to one organization", async () => {
    await expect(
      saveGithubInstallation(db, other, { installation: installation(), repositories: [] }),
    ).rejects.toBeInstanceOf(GithubInstallationTakenError);
    expect(await listGithubInstallations(db, other)).toEqual([]);
    await expect(disconnectGithubInstallation(db, other, installationId)).rejects.toMatchObject({ code: "not_found" });
  });

  test("the bot falls back to @github-bot when an older actor has @github", async () => {
    // Taken before "github" was reserved.
    const agent = await createAgent(db, other, { name: "Old github", handle: "old-github" });
    await db.update(schema.actors).set({ handle: "github" }).where(eq(schema.actors.id, agent.actor.id));
    await saveGithubInstallation(db, other, {
      installation: installation({ id: otherInstallationId, account: "jane", accountType: "User" }),
      repositories: [],
    });
    const bot = (await listMembers(db, other.orgId, { includeDeactivated: true })).find((m) => m.type === "integration");
    expect(bot?.handle).toBe("github-bot");
  });

  test("disconnecting keeps the repos, without the installation", async () => {
    await disconnectGithubInstallation(db, owner, installationId);
    expect(await listGithubInstallations(db, owner)).toEqual([]);
    expect((await listRepos(db, owner)).map((r) => [r.fullName, r.githubInstallationId])).toEqual([
      ["acme/api", null],
      ["acme/web", null],
    ]);
    await expect(disconnectGithubInstallation(db, owner, installationId)).rejects.toMatchObject({ code: "not_found" });
  });
});
