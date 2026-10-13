import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq, inArray } from "drizzle-orm";
import type { ActorContext } from "./access";
import { createAgent } from "./agents";
import { saveGithubInstallation } from "./github";
import {
  commitKeys,
  getTaskGit,
  nextPullRequestState,
  pullRequestKeys,
} from "./git-links";
import { handleGithubWebhook } from "./github-webhooks";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import { attachRepo, createRepo, detachRepo } from "./repos";
import { createTask, deleteTask } from "./tasks";

/**
 * A GitHub installation id for this test run. Ids are global on the shared test database, and
 * `Date.now()` plus an offset collided between files and concurrent runs (ST-142): random instead.
 */
const uniqueInstallationId = () =>
  10 ** 12 + Math.floor(Math.random() * 10 ** 12);

describe("task keys in pull requests and commits (ST-84)", () => {
  test("a PR's keys, each with the strongest way it is named", () => {
    const keys = pullRequestKeys({
      title: "ST-1: ship it, fixes ST-3",
      body: "Closes ST-2. See ST-4 and ST-1; UTF-8 everywhere.",
      headBranch: "st-1-ship-it",
    });
    expect(Object.fromEntries(keys)).toEqual({
      "ST-1": "branch",
      "ST-2": "closing",
      "ST-3": "closing",
      "ST-4": "body",
      "UTF-8": "body",
    });
    expect(
      Object.fromEntries(
        pullRequestKeys({
          title: "Docs for ST-5",
          body: null,
          headBranch: "main",
        }),
      ),
    ).toEqual({ "ST-5": "title" });
  });

  test("a commit's keys: closing keywords, the branch's key, mentions", () => {
    expect(
      Object.fromEntries(commitKeys("Fix ST-2\n\nrefs st-3", "ST-1")),
    ).toEqual({ "ST-2": "closing", "ST-1": "branch", "ST-3": "message" });
    expect(Object.fromEntries(commitKeys("resolves ST-1", "ST-1"))).toEqual({
      "ST-1": "closing",
    });
    expect(Object.fromEntries(commitKeys("WIP", null))).toEqual({});
  });

  test("the out-of-order guard: stale events change nothing, merged is final, ties never go back", () => {
    const at = (s: string) => new Date(`2026-10-12T10:00:${s}Z`);
    expect(
      nextPullRequestState(null, { state: "open", updatedAt: at("00") }),
    ).toBe("open");
    expect(
      nextPullRequestState(
        { state: "closed", githubUpdatedAt: at("10") },
        { state: "open", updatedAt: at("05") },
      ),
    ).toBeNull();
    expect(
      nextPullRequestState(
        { state: "closed", githubUpdatedAt: at("10") },
        { state: "open", updatedAt: at("20") },
      ),
    ).toBe("open");
    expect(
      nextPullRequestState(
        { state: "merged", githubUpdatedAt: at("10") },
        { state: "open", updatedAt: at("20") },
      ),
    ).toBe("merged");
    expect(
      nextPullRequestState(
        { state: "closed", githubUpdatedAt: at("10") },
        { state: "open", updatedAt: at("10") },
      ),
    ).toBe("closed");
    expect(
      nextPullRequestState(
        { state: "open", githubUpdatedAt: at("10") },
        { state: "merged", updatedAt: at("10") },
      ),
    ).toBe("merged");
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("git links from GitHub webhooks (ST-84)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const stamp = Date.now();
  const slug = `git-links-${stamp}`;
  // GitHub ids are global: unique per run (and apart from the other GitHub tests').
  const installationId = uniqueInstallationId();
  let owner: ActorContext;
  let n = 0;
  const deliveries: string[] = [];

  const deliver = (event: string, payload: Record<string, unknown>) => {
    const deliveryId = `${stamp}-links-${++n}`;
    deliveries.push(deliveryId);
    return handleGithubWebhook(db, {
      deliveryId,
      event,
      payload: { installation: { id: installationId }, ...payload },
    });
  };
  const repository = (name = "web", login = "acme") => ({
    name,
    owner: { login },
  });
  const sha = (c: string) => c.repeat(40);
  const commit = (
    id: string,
    message: string,
    timestamp = "2026-10-12T10:00:00+02:00",
  ) => ({
    id,
    message,
    timestamp,
    author: { name: "Ann Dev", email: "ann@example.com", username: "ann" },
  });
  const pullRequest = (fields: Record<string, unknown> = {}) => ({
    number: 7,
    title: "ST-1: Ship it",
    body: "Closes ST-2, see OPS-1 and UTF-8",
    state: "open",
    draft: true,
    merged: false,
    merged_at: null,
    closed_at: null,
    updated_at: "2026-10-12T10:00:00Z",
    head: { ref: "st-1-ship-it" },
    base: { ref: "main" },
    user: { login: "ann" },
    ...fields,
  });
  const git = (key: string, viewer: ActorContext = owner) =>
    getTaskGit(db, viewer, key);

  beforeAll(async () => {
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(
      db,
      { id: userId, name: "Owner", email: "owner@example.com" },
      { name: "Links", slug },
    );
    owner = {
      orgId: created.organization.id,
      actorId: created.actor.id,
      role: "owner",
      source: "ui",
    };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    // OPS is not attached to acme/web: its keys there link nothing.
    await createProject(db, owner, { name: "Ops", key: "OPS" });
    for (const title of ["Ship it", "Second", "Third", "Gone"])
      await createTask(db, owner, "ST", { title });
    await createTask(db, owner, "OPS", { title: "Ops task" });
    await deleteTask(db, owner, "ST-4");
    await createRepo(db, owner, { url: "acme/web", projects: ["ST"] });
    await createRepo(db, owner, { url: "acme/other" });
    await saveGithubInstallation(db, owner, {
      installation: {
        id: installationId,
        account: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
      },
      repositories: [
        { owner: "acme", name: "web", defaultBranch: "main" },
        { owner: "acme", name: "other", defaultBranch: "main" },
      ],
    });
  });

  afterAll(async () => {
    await db
      .delete(schema.githubDeliveries)
      .where(inArray(schema.githubDeliveries.id, deliveries));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("create links a branch named after a task of an attached project; others are ignored", async () => {
    expect(
      await deliver("create", {
        ref: "st-1-ship-it",
        ref_type: "branch",
        repository: repository(),
      }),
    ).toBe("processed");
    // Again: nothing new.
    expect(
      await deliver("create", {
        ref: "st-1-ship-it",
        ref_type: "branch",
        repository: repository(),
      }),
    ).toBe("ignored");
    for (const ignored of [
      { ref: "ops-1-thing", ref_type: "branch", repository: repository() },
      {
        ref: "st-1-elsewhere",
        ref_type: "branch",
        repository: repository("other"),
      },
      {
        ref: "st-1-unknown",
        ref_type: "branch",
        repository: repository("unknown"),
      },
      {
        ref: "st-4-deleted-task",
        ref_type: "branch",
        repository: repository(),
      },
      {
        ref: "st-99-no-such-task",
        ref_type: "branch",
        repository: repository(),
      },
      { ref: "utf-8-fix", ref_type: "branch", repository: repository() },
      { ref: "st-1", ref_type: "tag", repository: repository() },
    ]) {
      expect(await deliver("create", ignored)).toBe("ignored");
    }
    const { branches } = await git("ST-1");
    expect(branches).toEqual([
      {
        repo: "acme/web",
        name: "st-1-ship-it",
        url: "https://github.com/acme/web/tree/st-1-ship-it",
        deleted: false,
        linkedAt: expect.any(String),
      },
    ]);
  });

  test("push links commits by their messages and the branch's key; a stronger match upgrades the link", async () => {
    const result = await deliver("push", {
      ref: "refs/heads/st-1-ship-it",
      deleted: false,
      repository: repository(),
      commits: [
        commit(sha("a"), "WIP", "2026-10-12T10:00:00+02:00"),
        commit(
          sha("b"),
          "Mention ST-2 and UTF-8\n\nbody",
          "2026-10-12T11:00:00+02:00",
        ),
        commit(sha("c"), "Wire up OPS-1", "2026-10-12T12:00:00+02:00"),
      ],
    });
    expect(result).toBe("processed");
    expect(
      (await git("ST-1")).commits.map((c) => [
        c.sha.slice(0, 1),
        c.message,
        c.via,
        c.author,
      ]),
    ).toEqual([
      ["c", "Wire up OPS-1", "branch", "ann"],
      ["b", "Mention ST-2 and UTF-8", "branch", "ann"],
      ["a", "WIP", "branch", "ann"],
    ]);
    const second = (await git("ST-2")).commits;
    expect(second.map((c) => [c.sha, c.via, c.url, c.committedAt])).toEqual([
      [
        sha("b"),
        "message",
        `https://github.com/acme/web/commit/${sha("b")}`,
        "2026-10-12T09:00:00.000Z",
      ],
    ]);
    expect((await git("OPS-1")).commits).toEqual([]);

    // The same commit on main (after a merge), now with a closing keyword: ST-2's link gets stronger.
    expect(
      await deliver("push", {
        ref: "refs/heads/main",
        repository: repository(),
        commits: [commit(sha("b"), "Fixes ST-2")],
      }),
    ).toBe("processed");
    expect((await git("ST-2")).commits.map((c) => c.via)).toEqual(["closing"]);
    // A weaker match never downgrades it, and a repeat changes nothing.
    expect(
      await deliver("push", {
        ref: "refs/heads/main",
        repository: repository(),
        commits: [commit(sha("b"), "ST-2")],
      }),
    ).toBe("ignored");
    expect((await git("ST-2")).commits.map((c) => c.via)).toEqual(["closing"]);
    // Tags are ignored.
    expect(
      await deliver("push", {
        ref: "refs/tags/v1",
        repository: repository(),
        commits: [commit(sha("d"), "ST-3")],
      }),
    ).toBe("ignored");
  });

  test("a merge of main into a task branch doesn't link main's commits to the task; their message keys still link (ST-143)", async () => {
    const before = (await git("ST-2")).commits.map((c) => c.sha);
    // As GitHub sends it: main's commits are listed with distinct: false, the merge commit is new.
    const result = await deliver("push", {
      ref: "refs/heads/st-2-second",
      repository: repository(),
      commits: [
        {
          ...commit(
            sha("e"),
            "Unrelated work on main",
            "2026-10-12T13:00:00+02:00",
          ),
          distinct: false,
        },
        {
          ...commit(
            sha("f"),
            "Tweak for ST-2 on main",
            "2026-10-12T14:00:00+02:00",
          ),
          distinct: false,
        },
        {
          ...commit(
            sha("1"),
            "Merge branch 'main' into st-2-second",
            "2026-10-12T15:00:00+02:00",
          ),
          distinct: true,
        },
        commit(sha("2"), "Polish", "2026-10-12T16:00:00+02:00"),
      ],
    });
    expect(result).toBe("processed");
    const second = (await git("ST-2")).commits;
    expect(
      second.filter((c) => !before.includes(c.sha)).map((c) => [c.sha, c.via]),
    ).toEqual([
      [sha("2"), "branch"],
      [sha("1"), "branch"],
      // Named in its message: linked by that, not by the branch.
      [sha("f"), "message"],
    ]);
  });

  test("links of a repo detached from the project stay but aren't shown; attached again they are", async () => {
    expect((await git("ST-1")).commits.length).toBeGreaterThan(0);
    await detachRepo(db, owner, "ST", "acme/web");
    try {
      expect(await git("ST-1")).toEqual({
        taskKey: "ST-1",
        pullRequests: [],
        branches: [],
        commits: [],
      });
    } finally {
      await attachRepo(db, owner, "ST", { repo: "acme/web" });
    }
    expect((await git("ST-1")).commits.length).toBeGreaterThan(0);
  });

  test("a deleted branch stays linked, marked deleted; created again it is live again", async () => {
    expect(
      await deliver("delete", {
        ref: "st-1-ship-it",
        ref_type: "branch",
        repository: repository(),
      }),
    ).toBe("processed");
    expect((await git("ST-1")).branches.map((b) => b.deleted)).toEqual([true]);
    expect(
      await deliver("delete", {
        ref: "st-1-ship-it",
        ref_type: "branch",
        repository: repository(),
      }),
    ).toBe("ignored");
    // A push of the branch brings it back; a push that deletes it marks it again.
    expect(
      await deliver("push", {
        ref: "refs/heads/st-1-ship-it",
        repository: repository(),
        commits: [],
      }),
    ).toBe("processed");
    expect((await git("ST-1")).branches.map((b) => b.deleted)).toEqual([false]);
    expect(
      await deliver("push", {
        ref: "refs/heads/st-1-ship-it",
        deleted: true,
        repository: repository(),
        commits: [],
      }),
    ).toBe("processed");
    expect((await git("ST-1")).branches.map((b) => b.deleted)).toEqual([true]);
  });

  test("pull_request links by branch, closing keywords, title and body; stale events change nothing", async () => {
    expect(
      await deliver("pull_request", {
        action: "opened",
        number: 7,
        pull_request: pullRequest(),
        repository: repository(),
      }),
    ).toBe("processed");
    const [opened] = (await git("ST-1")).pullRequests;
    expect(opened).toEqual({
      repo: "acme/web",
      number: 7,
      title: "ST-1: Ship it",
      url: "https://github.com/acme/web/pull/7",
      state: "open",
      draft: true,
      headBranch: "st-1-ship-it",
      baseBranch: "main",
      author: "ann",
      mergedAt: null,
      closedAt: null,
      updatedAt: "2026-10-12T10:00:00.000Z",
      via: "branch",
    });
    expect(
      (await git("ST-2")).pullRequests.map((p) => [p.number, p.via]),
    ).toEqual([[7, "closing"]]);
    expect((await git("OPS-1")).pullRequests).toEqual([]);

    // Ready for review, then merged.
    expect(
      await deliver("pull_request", {
        action: "ready_for_review",
        number: 7,
        pull_request: pullRequest({
          draft: false,
          updated_at: "2026-10-12T11:00:00Z",
        }),
        repository: repository(),
      }),
    ).toBe("processed");
    const merged = pullRequest({
      draft: false,
      state: "closed",
      merged: true,
      merged_at: "2026-10-12T12:00:00Z",
      closed_at: "2026-10-12T12:00:00Z",
      updated_at: "2026-10-12T12:00:00Z",
    });
    expect(
      await deliver("pull_request", {
        action: "closed",
        number: 7,
        pull_request: merged,
        repository: repository(),
      }),
    ).toBe("processed");

    // A stale event (an older updated_at), arriving late: ignored, the merge stands.
    expect(
      await deliver("pull_request", {
        action: "converted_to_draft",
        number: 7,
        pull_request: pullRequest({
          title: "Stale title",
          draft: true,
          updated_at: "2026-10-12T10:30:00Z",
        }),
        repository: repository(),
      }),
    ).toBe("ignored");
    expect(
      (await git("ST-1")).pullRequests.map((p) => [
        p.state,
        p.draft,
        p.title,
        p.mergedAt,
      ]),
    ).toEqual([["merged", false, "ST-1: Ship it", "2026-10-12T12:00:00.000Z"]]);

    // A later edit drops ST-2 from the body: its link goes; merged stays merged.
    expect(
      await deliver("pull_request", {
        action: "edited",
        number: 7,
        pull_request: {
          ...merged,
          body: "No more keys",
          updated_at: "2026-10-12T13:00:00Z",
        },
        repository: repository(),
      }),
    ).toBe("processed");
    expect((await git("ST-2")).pullRequests).toEqual([]);
    expect(
      (await git("ST-1")).pullRequests.map((p) => [p.state, p.updatedAt]),
    ).toEqual([["merged", "2026-10-12T13:00:00.000Z"]]);
  });

  test("a PR that names no task here isn't kept; closed without merging is closed", async () => {
    expect(
      await deliver("pull_request", {
        action: "opened",
        number: 8,
        pull_request: pullRequest({
          number: 8,
          title: "Chore",
          body: null,
          head: { ref: "chore" },
        }),
        repository: repository(),
      }),
    ).toBe("ignored");
    const [stored] = await db
      .select()
      .from(schema.pullRequests)
      .where(eq(schema.pullRequests.number, 8));
    expect(stored).toBeUndefined();

    const closed = pullRequest({
      number: 9,
      title: "Try ST-3",
      body: null,
      head: { ref: "try" },
      state: "closed",
      merged: false,
      closed_at: "2026-10-12T14:00:00Z",
      updated_at: "2026-10-12T14:00:00Z",
    });
    expect(
      await deliver("pull_request", {
        action: "closed",
        number: 9,
        pull_request: closed,
        repository: repository(),
      }),
    ).toBe("processed");
    expect(
      (await git("ST-3")).pullRequests.map((p) => [
        p.number,
        p.state,
        p.via,
        p.closedAt,
      ]),
    ).toEqual([[9, "closed", "title", "2026-10-12T14:00:00.000Z"]]);
  });

  test("first events of a new PR arriving together save it once", async () => {
    const results = await Promise.all(
      ["opened", "labeled", "assigned"].map((action) =>
        deliver("pull_request", {
          action,
          number: 10,
          pull_request: pullRequest({
            number: 10,
            title: "ST-3 in parallel",
            head: { ref: "parallel" },
            body: null,
          }),
          repository: repository(),
        }),
      ),
    );
    expect(results).toEqual(["processed", "processed", "processed"]);
    expect((await git("ST-3")).pullRequests.map((p) => p.number)).toEqual([
      9, 10,
    ]);
  });

  test("a payload that doesn't match is refused", async () => {
    await expect(
      deliver("pull_request", {
        action: "opened",
        number: 1,
        pull_request: { number: 1 },
        repository: repository(),
      }),
    ).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      deliver("push", {
        ref: "refs/heads/x",
        repository: repository(),
        commits: [{ id: "nope", message: "x" }],
      }),
    ).rejects.toMatchObject({
      code: "validation",
    });
  });

  test("reading: unknown tasks and tasks outside an agent's projects are not found", async () => {
    expect(await git("ST-3")).toMatchObject({
      taskKey: "ST-3",
      branches: [],
      commits: [],
    });
    await expect(git("ST-99")).rejects.toMatchObject({ code: "not_found" });
    const { actor } = await createAgent(db, owner, { name: "Ops agent" });
    await db
      .update(schema.agents)
      .set({ scoped: true })
      .where(eq(schema.agents.actorId, actor.id));
    const ops = await getProject(db, owner.orgId, "OPS");
    await db
      .insert(schema.agentProjects)
      .values({ agentId: actor.id, projectId: ops.id });
    const opsAgent: ActorContext = {
      orgId: owner.orgId,
      actorId: actor.id,
      role: "member",
      source: "mcp",
    };
    await expect(git("ST-1", opsAgent)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await git("OPS-1", opsAgent)).toEqual({
      taskKey: "OPS-1",
      pullRequests: [],
      branches: [],
      commits: [],
    });
  });
});
