import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema, type Tx } from "@repo/db";
import { eq, sql } from "drizzle-orm";
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
import { recordDeployment } from "./deployments";
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
    // Released waits for web in prod (ST-94); the cli has no environments, so it doesn't.
    await expect(moveRelease(release.key, "Released")).rejects.toThrow("it isn't deployed web to prod yet");
    await recordDeployment(db, owner, release.key, { app: "web", environment: "prod", commitSha: "3f2c1ab" });
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
    // Only the release's own project (ST) goes into its changelog: OPS's task is left out (decision 16).
    expect(read.entries).toEqual([
      expect.objectContaining({ key: board.key, title: "Board columns", whatChanged: "- Release columns", apps: ["web"], handoff: expect.objectContaining({ authorId: owner.actorId }) }),
    ]);
    expect(read.markdown).not.toContain(quiet.key);
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

  // Scope review follow-ups (ST-93, ST-95): a project-scoped agent neither changes nor reads other projects' data through a release.
  const moveAs = async (ctx: ActorContext, key: string, projectKey: string, name: string) =>
    updateTask(db, ctx, key, { statusId: await statusOf(projectKey, "release", name) });
  const HIDDEN = "includes tasks in projects you can't see; ask a member";

  test("a project-scoped agent can't release, cancel or delete a release with tasks it can't see, and isn't told which", async () => {
    const st = await doneTask("ST", "Spider work (mixed)");
    const ops = await doneTask("OPS", "Ops work (mixed)");
    const release = await createRelease(db, owner, "OPS", { title: "ops-mixed", tasks: [st.key, ops.key] });
    for (const [name, action] of [["Released", "release it"], ["Canceled", "cancel it"]] as const) {
      const attempt = moveAs(opsAgent, release.key, "OPS", name);
      await expect(attempt).rejects.toThrow(`Release ${release.key} ${HIDDEN} to ${action}`);
    }
    await expect(deleteTask(db, opsAgent, release.key)).rejects.toThrow(`${HIDDEN} to delete it`);
    // Not even an unfinished task is named.
    await updateTask(db, owner, st.key, { statusId: await statusOf("ST", "task", "In Review") });
    const error = await moveAs(opsAgent, release.key, "OPS", "Released").catch((e: unknown) => e);
    expect(error instanceof Error ? error.message : "").not.toContain(st.key);
    expect((await moveAs(owner, release.key, "OPS", "Released").catch((e: Error) => e.message)) as string).toContain(`${st.key} isn't Done`);
    await updateTask(db, owner, st.key, { statusId: await statusOf("ST", "task", "Done") });
    // Nothing changed: still in the release, not shipped, the release still there.
    for (const key of [st.key, ops.key]) expect(await getTask(db, owner, key)).toMatchObject({ releaseId: release.id, shippedAt: null });
    expect((await getRelease(db, owner, release.key)).status.name).toBe("Planned");
    // Moves that don't touch the tasks are its to make; a release of its own tasks is too.
    expect((await moveAs(opsAgent, release.key, "OPS", "On staging")).statusId).toBe(await statusOf("OPS", "release", "On staging"));
    const own = await createRelease(db, opsAgent, "OPS", { title: "ops-own", tasks: [(await doneTask("OPS", "Own work")).key] });
    expect((await moveAs(opsAgent, own.key, "OPS", "Released")).shippedAt).not.toBeNull();
    await moveAs(opsAgent, own.key, "OPS", "Release review");
    await moveAs(opsAgent, own.key, "OPS", "Canceled");
    await deleteTask(db, opsAgent, own.key);
    // A person can.
    await moveAs(owner, release.key, "OPS", "Released");
    expect((await getTask(db, owner, st.key)).shippedAt).not.toBeNull();
  });

  /**
   * Runs `action` while another transaction holds the release row locked (as addToRelease does)
   * and makes `change` inside it; that transaction commits once `action` is blocked behind it.
   */
  const whileReleaseLocked = async <T>(releaseId: string, change: (tx: Tx) => Promise<unknown>, action: () => Promise<T>) => {
    let letGo = () => {};
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    let held: (pid: number) => void = () => {};
    const holding = new Promise<number>((resolve) => (held = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.id, releaseId)).for("update");
      await change(tx);
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      held(Number(row?.pid));
      await gate;
    });
    const pid = await holding;
    const outcome = action().then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : String(error) }),
    );
    for (let waited = 0; ; waited += 10) {
      const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`);
      if (Number(row?.n) > 0) break;
      if (waited > 5000) throw new Error("The action never waited for the lock");
      await Bun.sleep(10);
    }
    letGo();
    await holder;
    return outcome;
  };

  test("a release transition locks the release first: a task added meanwhile is checked, and a status changed meanwhile is a conflict (ST-140)", async () => {
    const ops = await doneTask("OPS", "Ops work (race)");
    const st = await doneTask("ST", "Spider work (race)");
    const release = await createRelease(db, owner, "OPS", { title: "ops-race", tasks: [ops.key] });
    // An owner adds an ST task while the OPS agent cancels: the cancel waits, then sees it and is refused.
    const canceled = await whileReleaseLocked(
      release.id,
      (tx) => tx.update(schema.tasks).set({ releaseId: release.id }).where(eq(schema.tasks.id, st.id)),
      () => moveAs(opsAgent, release.key, "OPS", "Canceled"),
    );
    expect(canceled.error).toBe(`Release ${release.key} ${HIDDEN} to cancel it`);
    for (const key of [st.key, ops.key]) expect((await getTask(db, owner, key)).releaseId).toBe(release.id);
    expect((await getRelease(db, owner, release.key)).status.name).toBe("Planned");

    // A move that read the release before another one changed it doesn't act on the old status.
    const own = await createRelease(db, opsAgent, "OPS", { title: "ops-race-own", tasks: [(await doneTask("OPS", "Own (race)")).key] });
    const onStaging = await statusOf("OPS", "release", "On staging");
    const late = await whileReleaseLocked(
      own.id,
      (tx) => tx.update(schema.tasks).set({ statusId: onStaging }).where(eq(schema.tasks.id, own.id)),
      () => moveAs(opsAgent, own.key, "OPS", "Canceled"),
    );
    expect(late.error).toBe(`Release ${own.key} changed meanwhile; try again`);
    expect((await getRelease(db, owner, own.key)).status.name).toBe("On staging");
  });

  test("shipping activity names the release only to viewers who can see it; hidden release ids read as hidden", async () => {
    const hidden = await doneTask("ST", "Hidden release work");
    const mine = await doneTask("OPS", "Mine, in an ST release");
    const release = await createRelease(db, owner, "ST", { title: "st-secret", tasks: [hidden.key, mine.key] });
    await moveRelease(release.key, "Released");
    // An entry in the older shape (key and version stored).
    const opsTask = await getTask(db, owner, mine.key);
    await db.insert(schema.activity).values({
      orgId: owner.orgId,
      actorId: owner.actorId,
      entityType: "task",
      entityId: opsTask.id,
      action: "task.unshipped",
      changes: { release: release.key, version: "st-secret" },
      source: "ui",
    });

    const seen = await listTaskActivity(db, owner, mine.key);
    expect(seen.find((e) => e.action === "task.shipped")?.changes).toEqual({ releaseId: release.id, release: release.key, version: "st-secret" });
    expect(seen.find((e) => e.action === "task.unshipped")?.changes).toEqual({ releaseId: null, release: release.key, version: "st-secret" });
    expect(seen.find((e) => Array.isArray(e.changes?.releaseId))?.changes).toEqual({ releaseId: [null, release.id] });

    const scoped = await listTaskActivity(db, opsAgent, mine.key);
    const none = { releaseId: null, release: null, version: null };
    expect(scoped.find((e) => e.action === "task.shipped")?.changes).toEqual(none);
    expect(scoped.find((e) => e.action === "task.unshipped")?.changes).toEqual(none);
    expect(scoped.find((e) => Array.isArray(e.changes?.releaseId))?.changes).toEqual({ releaseId: [null, "hidden"] });
    expect(JSON.stringify(scoped)).not.toContain(release.id);
    expect(JSON.stringify(scoped)).not.toContain("st-secret");
    expect(JSON.stringify(scoped)).not.toContain(release.key);
  });

  test("a project-scoped agent sees only the repos, apps and deployments it can see; its link changes keep the hidden ones; the bot still starts the release", async () => {
    await createRepo(db, owner, { url: "pipisasa/ops", projects: ["OPS"] });
    await createApp(db, owner, "pipisasa/ops", { name: "runbook", path: ".", versioning: "date", environments: ["staging", "prod"] });
    const st = await doneTask("ST", "Spider work (links)");
    const ops = await doneTask("OPS", "Ops work (links)");
    const release = await createRelease(db, owner, "OPS", {
      title: "ops-links",
      repos: ["pipisasa/site"],
      apps: [
        { repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.22" },
        { repo: "pipisasa/ops", app: "runbook", version: "2026.10.22" },
      ],
      tasks: [st.key, ops.key],
    });
    expect(release.repos.map((r) => r.fullName)).toEqual(["pipisasa/ops", "pipisasa/site", "pipisasa/spider-tracker"]);
    const seen = await getRelease(db, opsAgent, release.key);
    expect(seen.repos.map((r) => r.fullName)).toEqual(["pipisasa/ops"]);
    expect(seen.apps.map((a) => a.name)).toEqual(["runbook"]);

    // It can't deploy (or learn of) the hidden app; its own deploy still moves the mixed release on as the bot.
    const refused = await recordDeployment(db, opsAgent, release.key, { app: "web", environment: "prod", commitSha: "3f2c1ab" }).catch((e: Error) => e.message);
    expect(refused).toContain("doesn't ship web");
    expect(refused).not.toContain("spider-tracker");
    const deployed = await recordDeployment(db, opsAgent, release.key, { app: "runbook", environment: "staging", commitSha: "3f2c1ab" });
    expect(deployed.movedFrom?.name).toBe("Planned");
    expect(deployed.release.status.name).toBe("On staging");
    await recordDeployment(db, owner, release.key, { app: "web", environment: "staging", commitSha: "4e3d2bc" });
    expect((await getRelease(db, owner, release.key)).deployments?.map((d) => d.app)).toEqual(["web", "runbook"]);
    expect((await getRelease(db, opsAgent, release.key)).deployments?.map((d) => d.app)).toEqual(["runbook"]);

    const activity = await listTaskActivity(db, opsAgent, release.key);
    expect(activity.find((e) => e.changes?.repos !== undefined)?.changes).toEqual({ repos: [[], ["pipisasa/ops"]], apps: [[], ["runbook 2026.10.22"]] });
    expect(activity.filter((e) => e.action === "release.deployed").map((e) => e.changes)).toEqual([
      { app: "runbook", repo: "pipisasa/ops", environment: "staging", commitSha: "3f2c1ab" },
      { app: null, repo: null, environment: null, commitSha: null },
    ]);
    expect(JSON.stringify(activity)).not.toContain("spider-tracker");
    expect(JSON.stringify(activity)).not.toContain("pipisasa/site");

    // Released needs web in prod, which it can't see: refused without naming it (here the hidden task comes first).
    await expect(moveAs(opsAgent, release.key, "OPS", "Released")).rejects.toThrow(HIDDEN);
    const appsOnly = await createRelease(db, owner, "OPS", {
      title: "ops-apps",
      apps: [{ repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.23" }],
      tasks: [(await doneTask("OPS", "Ops only")).key],
    });
    const message = await moveAs(opsAgent, appsOnly.key, "OPS", "Released").catch((e: Error) => e.message);
    expect(message).toBe(`Release ${appsOnly.key} ships apps in repos you can't see that aren't deployed yet; ask a member to release it`);

    // Clearing its links removes only the ones it sees.
    const cleared = await updateRelease(db, opsAgent, release.key, { repos: [], apps: [] });
    expect([cleared.repos, cleared.apps]).toEqual([[], []]);
    const kept = await getRelease(db, owner, release.key);
    expect(kept.repos.map((r) => r.fullName)).toEqual(["pipisasa/site", "pipisasa/spider-tracker"]);
    expect(kept.apps.map((a) => `${a.name} ${a.version}`)).toEqual(["web 2026.10.22"]);
    expect((await listTaskActivity(db, opsAgent, release.key)).at(-1)?.changes).toEqual({ repos: [["pipisasa/ops"], []], apps: [["runbook 2026.10.22"], []] });
    expect((await listTaskActivity(db, owner, release.key)).at(-1)?.changes).toEqual({
      repos: [["pipisasa/ops", "pipisasa/site", "pipisasa/spider-tracker"], ["pipisasa/site", "pipisasa/spider-tracker"]],
      apps: [["runbook 2026.10.22", "web 2026.10.22"], ["web 2026.10.22"]],
    });

    // An older entry (no appRepos) can't tell the visible "web" from the hidden one: a scoped
    // viewer gets none of its app labels, even with a "web" app of its own (ST-140).
    await createApp(db, owner, "pipisasa/ops", { name: "web", path: "web", versioning: "date" });
    await db.insert(schema.activity).values({
      orgId: owner.orgId,
      actorId: owner.actorId,
      entityType: "task",
      entityId: release.id,
      action: "task.updated",
      changes: { repos: [[], ["pipisasa/ops", "pipisasa/spider-tracker"]], apps: [[], ["runbook 2026.10.24", "web 2026.10.24"]] },
      source: "ui",
    });
    expect((await listTaskActivity(db, opsAgent, release.key)).at(-1)?.changes).toEqual({ repos: [[], ["pipisasa/ops"]] });
    expect((await listTaskActivity(db, owner, release.key)).at(-1)?.changes).toEqual({
      repos: [[], ["pipisasa/ops", "pipisasa/spider-tracker"]],
      apps: [[], ["runbook 2026.10.24", "web 2026.10.24"]],
    });
  });

  test("changelog (ST-95) of a mixed release: only the release's own project, the same for every viewer; a scoped agent can't write it", async () => {
    const st = await createTask(db, owner, "ST", { title: "Secret spider feature", statusId: await statusOf("ST", "task", "Done") });
    const ops = await createTask(db, owner, "OPS", { title: "Ops runbook update", statusId: await statusOf("OPS", "task", "Done") });
    await addComment(db, owner, st.key, { body: "**What changed**\n- secret internals" });
    await addComment(db, owner, ops.key, { body: "**What changed**\n- new runbook steps" });
    const release = await createRelease(db, owner, "OPS", {
      title: "ops-notes",
      apps: [
        { repo: "pipisasa/spider-tracker", app: "web", version: "2026.10.24" },
        { repo: "pipisasa/ops", app: "runbook", version: "2026.10.24" },
      ],
      tasks: [st.key, ops.key],
    });

    const expected = `### runbook 2026.10.24\n\n- **${ops.key}** Ops runbook update\n  - new runbook steps`;
    for (const viewer of [owner, opsAgent]) {
      const read = await getReleaseChangelog(db, viewer, release.key);
      // web's repo isn't attached to OPS, so runbook is the one app and groups every entry.
      expect(read).toMatchObject({ grouped: true, apps: [{ name: "runbook" }], markdown: expected, description: { state: "missing" } });
      expect(read.entries.map((e) => e.key)).toEqual([ops.key]);
    }

    await expect(writeReleaseChangelog(db, opsAgent, release.key)).rejects.toThrow(`Release ${release.key} ${HIDDEN} to write its changelog`);
    expect((await getTask(db, owner, release.key)).description).toBeNull();

    expect(await writeReleaseChangelog(db, owner, release.key)).toMatchObject({ written: "added" });
    const description = (await getTask(db, opsAgent, release.key)).description ?? "";
    expect(description).toContain(expected);
    for (const leak of [st.key, "Secret spider feature", "secret internals", "web 2026.10.24"]) expect(description).not.toContain(leak);
    expect((await getReleaseChangelog(db, opsAgent, release.key)).description).toMatchObject({ state: "current", content: expected });
  });
});
