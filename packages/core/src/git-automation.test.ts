import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq, inArray } from "drizzle-orm";
import type { ActorContext } from "./access";
import { listTaskActivity } from "./activity-feed";
import type { GitAutomationSettings } from "./contracts";
import { DEFAULT_GIT_AUTOMATION, decideTransition, gitAutomationOf, pullRequestEvent, trustedPullRequest } from "./git-automation-rules";
import { getTaskGit } from "./git-links";
import { saveGithubInstallation } from "./github";
import { handleGithubWebhook } from "./github-webhooks";
import { createOrganization } from "./organizations";
import { archiveProject, createProject, getProject, updateProject } from "./projects";
import { createRepo } from "./repos";
import { createTask, getTask, updateTask } from "./tasks";

describe("status automation rules (ST-85)", () => {
  const settings: GitAutomationSettings = DEFAULT_GIT_AUTOMATION;

  test("pull_request actions as events, given the PR as saved", () => {
    const open = { state: "open" as const, draft: false, baseBranch: "main" };
    const draft = { state: "open" as const, draft: true, baseBranch: "main" };
    const merged = { state: "merged" as const, draft: false, baseBranch: "main" };
    expect(pullRequestEvent("opened", open, "main")).toBe("opened");
    expect(pullRequestEvent("opened", draft, "main")).toBe("draft");
    expect(pullRequestEvent("reopened", open, "main")).toBe("opened");
    expect(pullRequestEvent("ready_for_review", open, "main")).toBe("opened");
    expect(pullRequestEvent("converted_to_draft", draft, "main")).toBe("draft");
    expect(pullRequestEvent("closed", merged, "main")).toBe("merged");
    expect(pullRequestEvent("closed", { ...open, state: "closed" }, "main")).toBe("closed");
    for (const action of ["edited", "synchronize", "labeled", "assigned"]) expect(pullRequestEvent(action, open, "main")).toBeNull();
    // A merged PR stays merged (out-of-order guard): a late "opened" for it moves nothing.
    expect(pullRequestEvent("opened", merged, "main")).toBeNull();
  });

  test("a merge counts only into the default branch; other events whatever the base", () => {
    const stacked = { state: "merged" as const, draft: false, baseBranch: "st-84-links" };
    expect(pullRequestEvent("closed", stacked, "main")).toBeNull();
    expect(pullRequestEvent("closed", { ...stacked, baseBranch: "release/1.2" }, "main")).toBeNull();
    expect(pullRequestEvent("closed", { ...stacked, baseBranch: "trunk" }, "trunk")).toBe("merged");
    expect(pullRequestEvent("opened", { ...stacked, state: "open" }, "main")).toBe("opened");
    expect(pullRequestEvent("converted_to_draft", { ...stacked, state: "open", draft: true }, "main")).toBe("draft");
  });

  test("trusted pull requests: same repo, and an owner, member, collaborator or bot", () => {
    const same = { baseRepo: "acme/web", headRepo: "acme/web", authorType: "User" };
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(trustedPullRequest({ ...same, authorAssociation: association })).toBe(true);
    }
    expect(trustedPullRequest({ ...same, headRepo: "Acme/Web", authorAssociation: "MEMBER" })).toBe(true);
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", null]) {
      expect(trustedPullRequest({ ...same, authorAssociation: association })).toBe(false);
    }
    // A fork, or a fork that is gone, never: not even its owner's.
    expect(trustedPullRequest({ ...same, headRepo: "mallory/web", authorAssociation: "OWNER" })).toBe(false);
    expect(trustedPullRequest({ ...same, headRepo: null, authorAssociation: "MEMBER" })).toBe(false);
    // A bot (an App installed on the repo, like Spider Tracker's own for `spider pr`), from the repo only.
    expect(trustedPullRequest({ ...same, authorType: "Bot", authorAssociation: "NONE" })).toBe(true);
    expect(trustedPullRequest({ ...same, headRepo: "mallory/web", authorType: "Bot", authorAssociation: "NONE" })).toBe(false);
  });

  test("defaults: draft → In Progress, opened → In Review, merged → Done, closed → nothing", () => {
    const from = (current: Parameters<typeof decideTransition>[0]["current"], event: Parameters<typeof decideTransition>[0]["event"]) =>
      decideTransition({ event, current, settings, others: [] });
    expect(from("todo", "draft")).toBe("in_progress");
    expect(from("backlog", "opened")).toBe("in_review");
    expect(from("in_progress", "opened")).toBe("in_review");
    expect(from("in_review", "merged")).toBe("done");
    expect(from("todo", "merged")).toBe("done");
    expect(from("in_progress", "closed")).toBeNull();
  });

  test("forward only: never back, finished and canceled tasks stay", () => {
    expect(decideTransition({ event: "opened", current: "done", settings, others: [] })).toBeNull();
    expect(decideTransition({ event: "merged", current: "canceled", settings, others: [] })).toBeNull();
    expect(decideTransition({ event: "opened", current: "in_review", settings, others: [] })).toBeNull();
    // A target behind the task (here a custom one) isn't taken.
    expect(decideTransition({ event: "opened", current: "in_review", settings: { ...settings, opened: "todo" }, others: [] })).toBeNull();
  });

  test("a draft moves In Review back to In Progress, unless another linked PR is open and ready", () => {
    expect(decideTransition({ event: "draft", current: "in_review", settings, others: [] })).toBe("in_progress");
    expect(decideTransition({ event: "draft", current: "in_review", settings, others: [{ state: "open", draft: true }] })).toBe("in_progress");
    expect(decideTransition({ event: "draft", current: "in_review", settings, others: [{ state: "merged", draft: false }] })).toBe("in_progress");
    expect(decideTransition({ event: "draft", current: "in_review", settings, others: [{ state: "open", draft: false }] })).toBeNull();
  });

  test("merged moves to Done only when no other linked PR is open", () => {
    expect(decideTransition({ event: "merged", current: "in_review", settings, others: [{ state: "open", draft: true }] })).toBeNull();
    expect(decideTransition({ event: "merged", current: "in_review", settings, others: [{ state: "closed", draft: false }] })).toBe("done");
  });

  test("disabled or unset events change nothing", () => {
    expect(decideTransition({ event: "opened", current: "todo", settings: { ...settings, enabled: false }, others: [] })).toBeNull();
    expect(decideTransition({ event: "merged", current: "todo", settings: { ...settings, merged: null }, others: [] })).toBeNull();
    expect(decideTransition({ event: "closed", current: "in_review", settings: { ...settings, closed: "canceled" }, others: [] })).toBe("canceled");
  });

  test("stored settings: null or invalid are the defaults, partial ones fill in", () => {
    expect(gitAutomationOf(null)).toEqual(DEFAULT_GIT_AUTOMATION);
    expect(gitAutomationOf({ merged: "nope" })).toEqual(DEFAULT_GIT_AUTOMATION);
    expect(gitAutomationOf({ enabled: false })).toEqual({ ...DEFAULT_GIT_AUTOMATION, enabled: false });
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("status automation from GitHub pull requests (ST-85)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const stamp = Date.now();
  const slug = `git-auto-${stamp}`;
  const installationId = stamp + 400;
  let owner: ActorContext;
  let n = 0;
  const deliveries: string[] = [];
  let second = 0;

  const deliver = (event: string, payload: Record<string, unknown>) => {
    const deliveryId = `${stamp}-auto-${++n}`;
    deliveries.push(deliveryId);
    return handleGithubWebhook(db, { deliveryId, event, payload: { installation: { id: installationId }, ...payload } });
  };
  /** A PR's head branch, in the repo itself (not a fork). */
  const head = (ref: string) => ({ ref, repo: { full_name: "acme/web" } });
  /** A pull_request event; each one is newer than the last. */
  const pr = (action: string, fields: Record<string, unknown>, sender = "ann") => {
    second += 1;
    const updated_at = new Date(Date.UTC(2026, 9, 12, 10, 0, second)).toISOString();
    return deliver("pull_request", {
      action,
      repository: { name: "web", owner: { login: "acme" }, default_branch: "main" },
      sender: { login: sender, type: "User" },
      pull_request: {
        number: 1,
        title: "Work",
        body: null,
        state: "open",
        draft: false,
        merged: false,
        updated_at,
        head: head("feature"),
        base: { ref: "main" },
        user: { login: "ann", type: "User" },
        author_association: "MEMBER",
        ...fields,
      },
    });
  };
  const statusOf = async (key: string) => {
    const task = await getTask(db, owner, key);
    const project = await getProject(db, owner, key.split("-")[0]!);
    return Object.values(project.workflows).flat().find((s) => s.id === task.statusId)?.name;
  };

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(db, { id: userId, name: "Owner", email: "owner@example.com" }, { name: "Automation", slug });
    owner = { orgId: created.organization.id, actorId: created.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Off", key: "OFF" });
    for (let i = 1; i <= 8; i++) await createTask(db, owner, "ST", { title: `Task ${i}` });
    await createTask(db, owner, "ST", { title: "M1", kind: "milestone" });
    for (let i = 10; i <= 16; i++) await createTask(db, owner, "ST", { title: `Task ${i}` });
    await createTask(db, owner, "OFF", { title: "Off task" });
    await updateProject(db, owner, "OFF", { gitAutomation: { enabled: false } });
    // Two more projects on the same repo: one with its own settings, one archived.
    await createProject(db, owner, { name: "Two", key: "TWO" });
    await createTask(db, owner, "TWO", { title: "Two task" });
    await updateProject(db, owner, "TWO", { gitAutomation: { opened: null, merged: "in_review" } });
    await createProject(db, owner, { name: "Old", key: "OLD" });
    await createTask(db, owner, "OLD", { title: "Old task" });
    await createRepo(db, owner, { url: "acme/web", projects: ["ST", "OFF", "TWO", "OLD"] });
    await archiveProject(db, owner, "OLD", true);
    await saveGithubInstallation(db, owner, {
      installation: { id: installationId, account: "acme", accountType: "Organization", repositorySelection: "selected", suspended: false },
      repositories: [{ owner: "acme", name: "web", defaultBranch: "main" }],
    });
  });

  afterAll(async () => {
    await db.delete(schema.githubDeliveries).where(inArray(schema.githubDeliveries.id, deliveries));
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("the project's settings: defaults, partial changes, reset", async () => {
    expect((await getProject(db, owner, "ST")).gitAutomation).toEqual(DEFAULT_GIT_AUTOMATION);
    expect((await getProject(db, owner, "OFF")).gitAutomation).toEqual({ ...DEFAULT_GIT_AUTOMATION, enabled: false });
    const changed = await updateProject(db, owner, "ST", { gitAutomation: { closed: "canceled" } });
    expect(changed.gitAutomation).toEqual({ ...DEFAULT_GIT_AUTOMATION, closed: "canceled" });
    expect((await updateProject(db, owner, "ST", { gitAutomation: null })).gitAutomation).toEqual(DEFAULT_GIT_AUTOMATION);
    await expect(updateProject(db, owner, "ST", { gitAutomation: { merged: "shipped" } })).rejects.toMatchObject({ code: "validation" });
    await expect(updateProject(db, owner, "ST", { gitAutomation: {} })).rejects.toMatchObject({ code: "validation" });
  });

  test("draft → In Progress, ready → In Review, merged → Done, as @github", async () => {
    const branch = { head: head("st-1-work"), number: 11 };
    await pr("opened", { ...branch, draft: true });
    expect(await statusOf("ST-1")).toBe("In Progress");
    await pr("ready_for_review", branch);
    expect(await statusOf("ST-1")).toBe("In Review");
    await pr("converted_to_draft", { ...branch, draft: true });
    expect(await statusOf("ST-1")).toBe("In Progress");
    await pr("ready_for_review", branch);
    await pr("closed", { ...branch, state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z", closed_at: "2026-10-12T11:00:00Z" });
    expect(await statusOf("ST-1")).toBe("Done");
    expect((await getTask(db, owner, "ST-1")).completedAt).not.toBeNull();

    const activity = await listTaskActivity(db, owner, "ST-1");
    const moves = activity.filter((a) => a.action === "task.updated");
    expect(moves.length).toBe(5);
    expect(moves.every((a) => a.source === "git" && a.actorId !== owner.actorId)).toBe(true);
  });

  test("a closed, unmerged PR changes nothing; Done never goes back", async () => {
    const branch = { head: head("st-2-work"), number: 12 };
    await pr("opened", branch);
    expect(await statusOf("ST-2")).toBe("In Review");
    await pr("closed", { ...branch, state: "closed", closed_at: "2026-10-12T11:00:00Z" });
    expect(await statusOf("ST-2")).toBe("In Review");

    // ST-1 is Done: reopening its PR doesn't move it back.
    await pr("opened", { head: head("st-1-follow-up"), number: 13 });
    expect(await statusOf("ST-1")).toBe("Done");
  });

  test("only closing keywords, branch and title move tasks; a mention in the body doesn't", async () => {
    await pr("opened", { number: 14, title: "ST-3: by title", body: "Fixes ST-4. See ST-5." });
    expect(await statusOf("ST-3")).toBe("In Review");
    expect(await statusOf("ST-4")).toBe("In Review");
    expect(await statusOf("ST-5")).toBe("Todo");
  });

  test("merged waits for the task's other open PRs", async () => {
    await pr("opened", { number: 15, head: head("st-6-part-one") });
    await pr("opened", { number: 16, title: "ST-6 part two" });
    await pr("closed", { number: 15, head: head("st-6-part-one"), state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z" });
    expect(await statusOf("ST-6")).toBe("In Review");
    await pr("closed", { number: 16, title: "ST-6 part two", state: "closed", merged: true, merged_at: "2026-10-12T11:01:00Z" });
    expect(await statusOf("ST-6")).toBe("Done");
  });

  test("stale events, milestones and projects with automation off aren't moved", async () => {
    // ST-7 is In Progress by hand; an event older than the stored one changes nothing.
    await updateTask(db, owner, "ST-7", { statusId: (await getProject(db, owner, "ST")).statuses.find((s) => s.name === "In Progress")!.id });
    await pr("opened", { number: 17, head: head("st-7-work"), draft: true });
    second -= 5;
    await pr("ready_for_review", { number: 17, head: head("st-7-work") });
    second += 10;
    expect(await statusOf("ST-7")).toBe("In Progress");

    await pr("opened", { number: 18, title: "ST-9 and OFF-1" });
    expect(await statusOf("ST-9")).toBe("Planned");
    expect(await statusOf("OFF-1")).toBe("Todo");
  });

  test("a merge into another branch than the default (a stacked PR, a release branch) doesn't move to Done", async () => {
    const stacked = { number: 21, head: head("st-10-stacked"), base: { ref: "st-84-links" } };
    await pr("opened", stacked);
    expect(await statusOf("ST-10")).toBe("In Review");
    await pr("closed", { ...stacked, state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z" });
    expect(await statusOf("ST-10")).toBe("In Review");

    const release = { number: 22, head: head("st-11-hotfix"), base: { ref: "release/1.2" } };
    await pr("opened", release);
    await pr("closed", { ...release, state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z" });
    expect(await statusOf("ST-11")).toBe("In Review");

    // The same work merged into main later (a new PR naming the task) finishes it.
    const main = { number: 23, head: head("st-10-to-main") };
    await pr("opened", main);
    await pr("closed", { ...main, state: "closed", merged: true, merged_at: "2026-10-12T12:00:00Z" });
    expect(await statusOf("ST-10")).toBe("Done");
  });

  test("PRs from forks or non-members link but move nothing; a bot's own PR moves", async () => {
    const fork = { number: 24, head: { ref: "st-12-fork", repo: { full_name: "mallory/web" } }, author_association: "OWNER" };
    await pr("opened", fork);
    expect(await statusOf("ST-12")).toBe("Todo");
    await pr("closed", { ...fork, state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z" }, "ann");
    expect(await statusOf("ST-12")).toBe("Todo");
    // Still linked.
    expect((await getTaskGit(db, owner, "ST-12")).pullRequests).toMatchObject([{ number: 24, state: "merged", via: "branch" }]);

    await pr("opened", { number: 25, head: head("st-13-drive-by"), author_association: "NONE" });
    await pr("opened", { number: 26, head: head("st-14-contrib"), author_association: "CONTRIBUTOR" });
    await pr("opened", { number: 27, head: { ref: "st-15-gone", repo: null } });
    expect([await statusOf("ST-13"), await statusOf("ST-14"), await statusOf("ST-15")]).toEqual(["Todo", "Todo", "Todo"]);

    // An App's PR (its association is NONE) from a branch of the repo is trusted.
    await pr("opened", {
      number: 28,
      head: head("st-16-app"),
      user: { login: "spider-tracker[bot]", type: "Bot" },
      author_association: "NONE",
    });
    expect(await statusOf("ST-16")).toBe("In Review");
  });

  test("the activity names the PR, the event and who merged", async () => {
    const branch = { number: 29, head: head("st-8-traced") };
    await pr("opened", branch);
    await pr("closed", { ...branch, state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z" }, "bob");
    expect(await statusOf("ST-8")).toBe("Done");
    const moves = (await listTaskActivity(db, owner, "ST-8")).filter((a) => a.action === "task.updated");
    expect(moves.map((a) => a.changes?.pullRequest)).toEqual([
      { number: 29, event: "opened", sender: "ann" },
      { number: 29, event: "merged", sender: "bob" },
    ]);
  });

  test("projects on one repo each use their own settings; archived projects aren't moved", async () => {
    const both = { number: 30, title: "ST-5 TWO-1 OLD-1 together" };
    await pr("opened", both);
    expect(await statusOf("ST-5")).toBe("In Review");
    expect(await statusOf("TWO-1")).toBe("Todo");
    expect(await statusOf("OLD-1")).toBe("Todo");
    await pr("closed", { ...both, state: "closed", merged: true, merged_at: "2026-10-12T11:00:00Z" });
    expect(await statusOf("ST-5")).toBe("Done");
    expect(await statusOf("TWO-1")).toBe("In Review");
    expect(await statusOf("OLD-1")).toBe("Todo");
  });
});
