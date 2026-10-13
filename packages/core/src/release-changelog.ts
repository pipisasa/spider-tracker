import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  assertCanWrite,
  projectScope,
  type ActorContext,
  type Viewer,
} from "./access";
import type {
  ReleaseChangelogDto,
  ReleaseChangelogEntryDto,
  ReleaseDto,
} from "./contracts";
import { DomainError } from "./errors";
import {
  findHandoff,
  finishChangelog,
  regroupChangelog,
  releaseTag,
  withChangelog,
  type HandoffComment,
} from "./release-notes";
import { allReleaseTasks, assertSeesWholeRelease } from "./release-scope";
import { getRelease } from "./releases";
import { releaseChangelogInput } from "./schemas";
import { updateTask } from "./tasks";
import { parseInput } from "./validate";

// Release changelogs (ST-95): generated from the included tasks (their titles and the "What
// changed" part of their handoff notes, see release-notes.ts) and written into the release's
// description on request only, never on their own.
//
// The description is readable by everyone who can see the release, so the changelog holds only the
// release's own project: its tasks, and its apps in repos attached to that project. Included tasks
// of other projects are left out (decision 16), which also makes the changelog the same for every
// viewer who can see the release. Only an actor who can see every included task writes it.

const { apps, comments, projectRepos, taskAssignees } = schema;

/**
 * The changelog of a loaded release: the tasks of the release's own project and its apps in repos
 * attached to that project. A one-app release groups every task under its app.
 */
async function buildChangelog(
  db: Db,
  release: ReleaseDto,
): Promise<ReleaseChangelogDto> {
  const ownKey = release.key.slice(0, release.key.lastIndexOf("-"));
  const tasks = release.tasks.filter((t) => t.projectKey === ownKey);
  const appIds = release.apps.map((a) => a.appId);
  const attached = appIds.length
    ? await db
        .select({ id: apps.id })
        .from(apps)
        .innerJoin(
          projectRepos,
          and(
            eq(projectRepos.repoId, apps.repoId),
            eq(projectRepos.projectId, release.projectId),
          ),
        )
        .where(inArray(apps.id, appIds))
    : [];
  const releaseApps = release.apps.filter((a) =>
    attached.some((r) => r.id === a.appId),
  );
  const ids = tasks.map((t) => t.id);
  const commentRows = ids.length
    ? await db
        .select({
          id: comments.id,
          taskId: comments.taskId,
          authorId: comments.authorId,
          body: comments.body,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(and(inArray(comments.taskId, ids), isNull(comments.deletedAt)))
        .orderBy(desc(comments.createdAt))
    : [];
  const assigneeRows = ids.length
    ? await db
        .select({
          taskId: taskAssignees.taskId,
          actorId: taskAssignees.actorId,
        })
        .from(taskAssignees)
        .where(inArray(taskAssignees.taskId, ids))
    : [];
  const oneApp = releaseApps.length === 1 ? releaseApps[0]?.name : undefined;

  const entries = tasks.map((task): ReleaseChangelogEntryDto => {
    const own: HandoffComment[] = commentRows
      .filter((c) => c.taskId === task.id)
      .map((c) => ({
        id: c.id,
        authorId: c.authorId,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      }));
    const handoff = findHandoff(
      own,
      assigneeRows.filter((a) => a.taskId === task.id).map((a) => a.actorId),
    );
    return {
      key: task.key,
      title: task.title,
      projectKey: task.projectKey,
      whatChanged: handoff?.whatChanged ?? null,
      handoff: handoff
        ? {
            commentId: handoff.comment.id,
            authorId: handoff.comment.authorId,
            createdAt: handoff.comment.createdAt,
          }
        : null,
      apps: oneApp ? [oneApp] : [],
    };
  });

  return finishChangelog(
    {
      release: { id: release.id, key: release.key, title: release.title },
      apps: releaseApps.map((a) => ({
        name: a.name,
        repo: a.repo,
        version: a.version,
        tag: releaseTag(a, a.version),
      })),
      grouped: oneApp !== undefined,
      entries,
    },
    release.description,
  );
}

/** A release's generated changelog and how its description's changelog block compares. */
export async function getReleaseChangelog(
  db: Db,
  viewer: Viewer,
  releaseKey: string,
): Promise<ReleaseChangelogDto> {
  return buildChangelog(db, await getRelease(db, viewer, releaseKey));
}

/**
 * Writes the generated changelog into the release's description: replaces its changelog block, or
 * appends one, leaving the rest of the description as it is. `taskApps` groups it by app. A block
 * edited by hand since it was written is a conflict unless `force`. Refused for a scoped actor when
 * the release includes tasks it can't see.
 */
export async function writeReleaseChangelog(
  db: Db,
  ctx: ActorContext,
  releaseKey: string,
  input: unknown = {},
): Promise<ReleaseChangelogDto> {
  assertCanWrite(ctx);
  const { taskApps, force } = parseInput(releaseChangelogInput, input);
  const release = await getRelease(db, ctx, releaseKey);
  assertSeesWholeRelease(
    await projectScope(db, ctx),
    release.key,
    await allReleaseTasks(db, release.id),
    "write its changelog",
  );
  const built = await buildChangelog(db, release);
  const changelog = taskApps ? regroupChangelog(built, taskApps) : built;
  const { state } = changelog.description;
  if (state === "edited" && !force) {
    throw new DomainError(
      "conflict",
      `The changelog in ${release.key}'s description was edited by hand since it was generated. Edit it there, or write with force to replace it (the edits are lost)`,
    );
  }
  if (state === "current") return { ...changelog, written: "unchanged" };
  await updateTask(db, ctx, release.key, {
    description: withChangelog(release.description, changelog.markdown),
  });
  return {
    ...changelog,
    description: { state: "current", content: changelog.markdown },
    written: state === "missing" ? "added" : "replaced",
  };
}
