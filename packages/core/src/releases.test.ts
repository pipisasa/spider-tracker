import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { eq } from "drizzle-orm";
import type { ActorContext } from "./access";
import { listTaskActivity } from "./activity-feed";
import { createAgent } from "./agents";
import { boardColumns, shippingLabel } from "./board";
import type { TaskDto } from "./contracts";
import { createOrganization } from "./organizations";
import { createProject, getProject } from "./projects";
import { addComment } from "./comments";
import { getReleaseChangelog, writeReleaseChangelog } from "./release-changelog";
import { addToRelease, createRelease, getRelease, listReleaseCandidates, listReleases, removeFromRelease, updateRelease } from "./releases";
import { createApp, createRepo, getRepo } from "./repos";
import { firstStatusOf } from "./statuses";
import { createTask, deleteTask, getTask, listTasks, updateTask, updateTasks } from "./tasks";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("releases (ST-93)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const slug = `releases-${Date.now()}`;
  let owner: ActorContext;
  /** An agent limited to OPS. */
  let opsAgent: ActorContext;

  const statusOf = async (projectKey: string, kind: "task" | "release", name: string) => {
    const project = await getProject(db, owner, projectKey);
    const status = project.workflows[kind].find((s) => s.name === name);
    if (!status) throw new Error(`No ${name}`);
    return status.id;
  };
  const doneTask = async (projectKey: string, title: string): Promise<TaskDto> =>
    createTask(db, owner, projectKey, { title, statusId: await statusOf(projectKey, "task", "Done") });
  const moveRelease = async (key: string, name: string) => updateTask(db, owner, key, { statusId: await statusOf("ST", "release", name) });

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const org = await createOrganization(db, { id: userId, name: "Owner", email: "owner@example.com" }, { name: "Releases", slug });
    owner = { orgId: org.organization.id, actorId: org.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createProject(db, owner, { name: "Ops", key: "OPS" });
    await createProject(db, owner, { name: "Site", key: "SITE" });
    await createRepo(db, owner, { url: "pipisasa/spider-tracker", projects: ["ST"] });
    await createRepo(db, owner, { url: "pipisasa/site", projects: ["SITE"] });
    await createRepo(db, owner, { url: "pipisasa/loose" });
    await createApp(db, owner, "pipisasa/spider-tracker", { name: "web", path: "web/app", versioning: "date", environments: ["staging", "prod"] });
    await createApp(db, owner, "pipisasa/spider-tracker", { name: "cli", path: "backend/cli", versioning: "semver" });
    await createApp(db, owner, "pipisasa/site", { name: "site", path: ".", versioning: "date" });
    const { actor } = await createAgent(db, owner, { name: "Ops agent" });
    await db.update(schema.agents).set({ scoped: true }).where(eq(schema.agents.actorId, actor.id));
    await db.insert(schema.agentProjects).values({ agentId: actor.id, projectId: (await getProject(db, owner, "OPS")).id });
    opsAgent = { orgId: owner.orgId, actorId: actor.id, role: "member", source: "mcp" };
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("a release in ST includes three Done tasks from two projects; Released ships them, status unchanged; the board puts it in Released", async () => {
    const tasks = [await doneTask("ST", "Kinds"), await doneTask("ST", "Dates"), await doneTask("OPS", "Runbook")];
    expect(tasks.map((t) => t.shipping)).toEqual([
      { state: "not_in_release", release: null },
      { state: "not_in_release", release: null },
      { state: "not_in_release", release: null },
    ]);
    const candidates = (await listReleaseCandidates(db, owner)).map((t) => t.key);
    expect(candidates).toEqual(expect.arrayContaining(tasks.map((t) => t.key)));

    const release = await createRelease(db, owner, "st", {
      title: "2026.10.13",
      apps: [
        { repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.13" },
        { repo: "pipisasa/spider-tracker", app: "cli", version: "v0.1.8" },
      ],
      repos: ["pipisasa/site"],
      tasks: tasks.slice(0, 2).map((t) => t.key),
    });
    expect(release).toMatchObject({
      kind: "release",
      title: "2026.10.13",
      status: { name: "Planned", category: "todo" },
      shipping: null,
      repos: [{ fullName: "pipisasa/site" }, { fullName: "pipisasa/spider-tracker" }],
      apps: [
        { name: "cli", version: "0.1.8", versioning: "semver", repo: "pipisasa/spider-tracker" },
        { name: "web", version: "2026.10.13", versioning: "date", environments: ["staging", "prod"] },
      ],
      tasks: [{ key: tasks[0]?.key }, { key: tasks[1]?.key }],
    });
    const added = await addToRelease(db, owner, release.key, { tasks: [tasks[2]?.key ?? "", tasks[0]?.key ?? ""] });
    expect(added.tasks.map((t) => t.key)).toEqual([2, 0, 1].map((i) => tasks[i]?.key ?? ""));
    expect(await listReleaseCandidates(db, owner)).not.toContainEqual(expect.objectContaining({ key: tasks[0]?.key }));

    const onTheWay = await getTask(db, owner, tasks[0]?.key ?? "");
    expect(onTheWay).toMatchObject({ releaseId: release.id, shippedAt: null, shipping: { state: "in_release", release: { key: release.key, title: "2026.10.13" } } });
    expect(shippingLabel(onTheWay.shipping)).toBe("2026.10.13 · planned");

    await moveRelease(release.key, "On staging");
    const shipped = await moveRelease(release.key, "Released");
    expect(shipped.shippedAt).not.toBeNull();
    for (const task of tasks) {
      const after = await getTask(db, owner, task.key);
      expect(after.statusId).toBe(task.statusId);
      expect(after.shippedAt).toBe(shipped.shippedAt);
      expect(after.shipping).toMatchObject({ state: "shipped", release: { key: release.key, status: { name: "Released" } } });
      expect(shippingLabel(after.shipping)).toBe("shipped 2026.10.13");
      const activity = await listTaskActivity(db, owner, task.key);
      expect(activity.at(-1)).toMatchObject({ action: "task.shipped", changes: { release: release.key, version: "2026.10.13" } });
    }

    const project = await getProject(db, owner, "ST");
    const columns = boardColumns(project, await listTasks(db, owner, "ST", { kind: "task" }), await listReleases(db, owner, "ST"));
    expect(columns.map((c) => `${c.type}:${c.status.name}`)).toEqual([
      "tasks:Backlog", "tasks:Todo", "tasks:In Progress", "tasks:In Review", "tasks:Done", "tasks:Canceled",
      "releases:Planned", "releases:On staging", "releases:Release review", "releases:Released", "releases:Canceled",
    ]);
    const released = columns.find((c) => c.type === "releases" && c.status.name === "Released");
    expect(released?.type === "releases" ? released.releases.map((r) => r.key) : []).toEqual([release.key]);
    expect(boardColumns(project, [], [], { releaseColumns: false }).every((c) => c.type === "tasks")).toBe(true);

    // Shipped: nothing more goes in or out; moving it back unships.
    await expect(addToRelease(db, owner, release.key, { tasks: [(await doneTask("ST", "Late")).key] })).rejects.toThrow("Released");
    await expect(removeFromRelease(db, owner, release.key, { tasks: [tasks[0]?.key ?? ""] })).rejects.toThrow("Released");
    await moveRelease(release.key, "Release review");
    expect((await getTask(db, owner, tasks[0]?.key ?? "")).shipping?.state).toBe("in_release");
    expect((await listTaskActivity(db, owner, tasks[0]?.key ?? "")).at(-1)).toMatchObject({ action: "task.unshipped" });
    await moveRelease(release.key, "Released");
    expect(await listReleases(db, owner, "ST", { app: "web" })).toHaveLength(1);
    expect(await listReleases(db, owner, "ST", { app: "site" })).toHaveLength(0);
    expect(await listReleases(db, owner, "ST", { status: ["done"] })).toHaveLength(1);
  });

  test("only Done tasks go in, one release per task; removing, no code, Released needs every task Done", async () => {
    const release = await createRelease(db, owner, "ST", { title: "2026.10.14" });
    const other = await createRelease(db, owner, "ST", { title: "2026.10.15" });
    const open = await createTask(db, owner, "ST", { title: "Open work" });
    expect(open.shipping).toBeNull();
    await expect(addToRelease(db, owner, release.key, { tasks: [open.key] })).rejects.toThrow("only Done tasks go into a release");
    await expect(addToRelease(db, owner, release.key, { tasks: [other.key] })).rejects.toThrow("only tasks go into a release");
    await expect(addToRelease(db, owner, open.key, { tasks: [other.key] })).rejects.toThrow("not a release");

    const done = await doneTask("ST", "Finished");
    await addToRelease(db, owner, release.key, { tasks: [done.key] });
    await expect(addToRelease(db, owner, other.key, { tasks: [done.key] })).rejects.toThrow(`already in release ${release.key} (2026.10.14)`);
    // Adding again changes nothing.
    expect((await addToRelease(db, owner, release.key, { tasks: [done.key] })).tasks).toHaveLength(1);

    // A task reopened inside the release blocks Released until it is Done again.
    await updateTask(db, owner, done.key, { statusId: await statusOf("ST", "task", "In Review") });
    await expect(moveRelease(release.key, "Released")).rejects.toThrow(`${done.key} isn't Done`);
    await updateTask(db, owner, done.key, { statusId: await statusOf("ST", "task", "Done") });

    expect((await removeFromRelease(db, owner, release.key, { tasks: [done.key] })).tasks).toEqual([]);
    await expect(removeFromRelease(db, owner, release.key, { tasks: [done.key] })).rejects.toThrow("isn't in release");
    expect((await getTask(db, owner, done.key)).shipping).toEqual({ state: "not_in_release", release: null });

    // No code: not a candidate and never needs a release.
    const noCode = await updateTask(db, owner, done.key, { noCode: true });
    expect(noCode.shipping).toEqual({ state: "no_code", release: null });
    expect(shippingLabel(noCode.shipping)).toBe("no code");
    expect(await listReleaseCandidates(db, owner, { project: "ST", release: release.key })).not.toContainEqual(expect.objectContaining({ key: done.key }));
    await expect(updateTask(db, owner, release.key, { noCode: true })).rejects.toThrow("Only tasks have code");
    const bulk = await updateTasks(db, owner, { keys: [done.key], set: { noCode: false } });
    expect(bulk.results[0]?.task?.shipping?.state).toBe("not_in_release");
  });

  test("canceling or deleting a release frees its tasks", async () => {
    const release = await createRelease(db, owner, "ST", { title: "2026.10.16" });
    const task = await doneTask("ST", "Freed");
    await addToRelease(db, owner, release.key, { tasks: [task.key] });
    await moveRelease(release.key, "Canceled");
    expect((await getTask(db, owner, task.key)).shipping?.state).toBe("not_in_release");
    await expect(addToRelease(db, owner, release.key, { tasks: [task.key] })).rejects.toThrow("reopen it first");

    const second = await createRelease(db, owner, "ST", { title: "2026.10.17", tasks: [task.key] });
    await deleteTask(db, owner, second.key);
    expect(await getTask(db, owner, task.key)).toMatchObject({ releaseId: null, shipping: { state: "not_in_release" } });
  });

  test("apps need versions in their versioning; repos must be reachable and attached", async () => {
    await expect(
      createRelease(db, owner, "ST", { title: "bad", apps: [{ repo: "pipisasa/spider-tracker", app: "web", version: "1.2.3" }] }),
    ).rejects.toThrow('web: "1.2.3" isn\'t a date version like 2026.10.13');
    await expect(
      createRelease(db, owner, "ST", { title: "bad", apps: [{ repo: "pipisasa/spider-tracker", app: "cli", version: "1.2" }] }),
    ).rejects.toThrow("isn't a semver version");
    await expect(createRelease(db, owner, "ST", { title: "bad", apps: [{ repo: "pipisasa/spider-tracker", app: "nope", version: "1.0.0" }] })).rejects.toThrow(
      "App nope not found",
    );
    await expect(createRelease(db, owner, "ST", { title: "bad", repos: ["pipisasa/loose"] })).rejects.toThrow("isn't attached to a project");

    const release = await createRelease(db, owner, "ST", { title: "2026.10.18", apps: [{ repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.18" }] });
    expect(release.repos.map((r) => r.fullName)).toEqual(["pipisasa/spider-tracker"]);
    const updated = await updateRelease(db, owner, release.key, {
      apps: [{ repo: "pipisasa/site", app: "site", version: "2026.10.18" }],
      repos: [],
    });
    expect(updated.repos.map((r) => r.fullName)).toEqual(["pipisasa/site"]);
    expect(updated.apps.map((a) => `${a.name} ${a.version}`)).toEqual(["site 2026.10.18"]);
    expect((await listTaskActivity(db, owner, release.key)).at(-1)).toMatchObject({
      action: "task.updated",
      changes: { repos: [["pipisasa/spider-tracker"], ["pipisasa/site"]], apps: [["web 2026.10.18"], ["site 2026.10.18"]] },
    });
    // The project-scoped agent can't reach ST's repo.
    await expect(
      createRelease(db, opsAgent, "OPS", { title: "ops", repos: ["pipisasa/spider-tracker"] }),
    ).rejects.toThrow("not found");
  });

  test("a project-scoped agent sees a release's tasks only within its projects", async () => {
    const st = await doneTask("ST", "Spider work");
    const ops = await doneTask("OPS", "Ops work");
    const release = await createRelease(db, owner, "OPS", { title: "ops-1", tasks: [st.key, ops.key] });
    expect(release.tasks).toHaveLength(2);
    const seen = await getRelease(db, opsAgent, release.key);
    expect(seen.tasks.map((t) => t.key)).toEqual([ops.key]);
    expect((await listReleaseCandidates(db, opsAgent)).every((t) => t.key.startsWith("OPS-"))).toBe(true);
    // It can't add tasks of projects it can't see, nor see a release in them.
    const other = await doneTask("ST", "Hidden");
    await expect(addToRelease(db, opsAgent, release.key, { tasks: [other.key] })).rejects.toThrow("not found");
    const stRelease = await createRelease(db, owner, "ST", { title: "st-hidden", tasks: [other.key] });
    await expect(getRelease(db, opsAgent, stRelease.key)).rejects.toThrow("not found");
    // A task of its own in a release it can't see: in a release, without naming it.
    const mixed = await doneTask("OPS", "In a hidden release");
    await addToRelease(db, owner, stRelease.key, { tasks: [mixed.key] });
    expect(await getTask(db, opsAgent, mixed.key)).toMatchObject({ releaseId: null, shipping: { state: "in_release", release: null } });
    expect(shippingLabel((await getTask(db, opsAgent, mixed.key)).shipping)).toBe("in a release");
    expect(firstStatusOf(await getProject(db, owner, "ST"), "done", "release")?.name).toBe("Released");
  });

  test("changelog (ST-95): titles plus each handoff's What changed, grouped by app, written into the description without clobbering edits", async () => {
    const board = await createTask(db, owner, "ST", { title: "Board columns", statusId: await statusOf("ST", "task", "Done"), assigneeIds: [owner.actorId] });
    const cli = await doneTask("ST", "Release check");
    const quiet = await doneTask("OPS", "No handoff");
    await addComment(db, owner, board.key, { body: "**What changed**\n- old summary\n\n**Verified**\n- ok" });
    await addComment(db, owner, board.key, { body: "**Handoff:** branch x.\n\n**What changed**\n- Release columns\n\n**Open**\n- none" });
    await addComment(db, owner, board.key, { body: "Approved." });
    await addComment(db, owner, cli.key, { body: "## What changed\n`spider release check`" });

    // One app: every task is under it.
    const single = await createRelease(db, owner, "ST", {
      title: "2026.10.20",
      description: "Hand-written intro.",
      apps: [{ repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.20" }],
      tasks: [board.key, quiet.key],
    });
    const read = await getReleaseChangelog(db, owner, single.key);
    expect(read).toMatchObject({
      release: { key: single.key, title: "2026.10.20" },
      apps: [{ name: "web", repo: "pipisasa/spider-tracker", version: "2026.10.20", tag: "web-2026.10.20" }],
      grouped: true,
      description: { state: "missing", content: null },
      written: null,
    });
    expect(read.entries).toEqual([
      expect.objectContaining({ key: quiet.key, whatChanged: null, handoff: null, apps: ["web"] }),
      expect.objectContaining({ key: board.key, title: "Board columns", whatChanged: "- Release columns", apps: ["web"], handoff: expect.objectContaining({ authorId: owner.actorId }) }),
    ].sort((a, b) => (a.key < b.key ? -1 : 1)));
    expect(read.markdown).toContain(`### web 2026.10.20\n\n`);
    expect(read.markdown).toContain(`- **${board.key}** Board columns\n  - Release columns`);

    const written = await writeReleaseChangelog(db, owner, single.key);
    expect(written).toMatchObject({ written: "added", description: { state: "current", content: read.markdown } });
    const description = (await getTask(db, owner, single.key)).description ?? "";
    expect(description.startsWith("Hand-written intro.\n\n<!-- spider:changelog hash=")).toBe(true);
    expect(await writeReleaseChangelog(db, owner, single.key)).toMatchObject({ written: "unchanged" });

    // A new task makes it outdated; writing replaces only the block.
    await addToRelease(db, owner, single.key, { tasks: [cli.key] });
    expect((await getReleaseChangelog(db, owner, single.key)).description.state).toBe("outdated");
    expect(await writeReleaseChangelog(db, owner, single.key)).toMatchObject({ written: "replaced" });
    expect((await getTask(db, owner, single.key)).description).toContain("`spider release check`");

    // A hand edit is kept unless forced.
    const edited = ((await getTask(db, owner, single.key)).description ?? "").replace("Board columns", "Board columns (reworded)");
    await updateTask(db, owner, single.key, { description: edited });
    expect((await getReleaseChangelog(db, owner, single.key)).description.state).toBe("edited");
    await expect(writeReleaseChangelog(db, owner, single.key)).rejects.toThrow("edited by hand");
    expect((await getTask(db, owner, single.key)).description).toBe(edited);
    expect(await writeReleaseChangelog(db, owner, single.key, { force: true })).toMatchObject({ written: "replaced", description: { state: "current" } });

    // Several apps: one list until taskApps (from the CLI's git scan) groups it.
    const multi = await createRelease(db, owner, "ST", {
      title: "2026.10.21",
      apps: [
        { repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.21" },
        { repo: "pipisasa/spider-tracker", app: "cli", version: "0.2.1" },
      ],
    });
    await removeFromRelease(db, owner, single.key, { tasks: [board.key, cli.key] });
    await addToRelease(db, owner, multi.key, { tasks: [board.key, cli.key] });
    const flat = await getReleaseChangelog(db, owner, multi.key);
    expect(flat.grouped).toBe(false);
    expect(flat.markdown.startsWith("### Changes\n")).toBe(true);
    const grouped = await writeReleaseChangelog(db, owner, multi.key, { taskApps: { [board.key]: ["web"], [cli.key]: ["cli", "nope"] } });
    expect(grouped).toMatchObject({ grouped: true, written: "added" });
    expect(grouped.apps.map((a) => a.tag)).toEqual(["cli-v0.2.1", "web-2026.10.21"]);
    expect(grouped.markdown).toBe(`### cli 0.2.1\n\n- **${cli.key}** Release check\n  \`spider release check\`\n\n### web 2026.10.21\n\n- **${board.key}** Board columns\n  - Release columns`);
    // The project-scoped agent can't write a release it can't see.
    await expect(writeReleaseChangelog(db, opsAgent, multi.key)).rejects.toThrow("not found");
  });

  test("candidates for a release with repos leave out tasks whose commits are all in other repos (ST-84)", async () => {
    const [inRepo, elsewhere, both, unlinked] = [
      await doneTask("ST", "Commits in spider-tracker"),
      await doneTask("ST", "Commits in site only"),
      await doneTask("ST", "Commits in both"),
      await doneTask("ST", "No commits linked"),
    ];
    const tracker = await getRepo(db, owner, "pipisasa/spider-tracker");
    const site = await getRepo(db, owner, "pipisasa/site");
    let n = 0;
    const link = async (task: TaskDto | undefined, repoId: string, kind: "commit" | "branch" = "commit") =>
      db.insert(schema.gitLinks).values({
        orgId: owner.orgId,
        taskId: task?.id ?? "",
        repoId,
        kind,
        ref: kind === "commit" ? String(++n).padStart(40, "0") : "st-branch",
        via: kind === "commit" ? "message" : "branch",
      });
    await link(inRepo, tracker.id);
    await link(elsewhere, site.id);
    // A branch alone isn't code in another repo.
    await link(unlinked, site.id, "branch");
    await link(both, site.id);
    await link(both, tracker.id);

    const keys = async (release?: string) => (await listReleaseCandidates(db, owner, { release })).map((t) => t.key);
    const withRepo = await createRelease(db, owner, "ST", { title: "2026.10.20", repos: ["pipisasa/spider-tracker"] });
    const forRelease = await keys(withRepo.key);
    expect(forRelease).toEqual(expect.arrayContaining([inRepo, both, unlinked].map((t) => t?.key)));
    expect(forRelease).not.toContain(elsewhere?.key);

    // Without repos (or without a release), every Done task with code is a candidate.
    const bare = await createRelease(db, owner, "ST", { title: "2026.10.21" });
    for (const list of [await keys(bare.key), await keys()]) {
      expect(list).toEqual(expect.arrayContaining([inRepo, elsewhere, both, unlinked].map((t) => t?.key)));
    }
  });
});
