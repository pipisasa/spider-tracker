import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  assertCanWrite,
  inScope,
  projectScope,
  type ActorContext,
  type ProjectScope,
  type Viewer,
} from "./access";
import type {
  MilestoneDto,
  MilestoneReleaseDto,
  MilestoneTaskDto,
  TaskDto,
} from "./contracts";
import { DomainError } from "./errors";
import { milestoneMembers, progressOf } from "./milestone-membership";
import { getProject } from "./projects";
import { createMilestoneInput, milestoneListFilters } from "./schemas";
import { createTaskIn, findTask, listTasks, toTaskDtos } from "./tasks";
import { parseInput } from "./validate";

// Milestones (ST-96): tasks of kind "milestone", with the workflow Planned → Active → Ready to
// close → Done. Goal and "Done when" go in the description; start and target dates place them on
// the project's roadmap, and several can be Active at once. Tasks of the same project join one
// through `milestoneId` (sub-tasks inherit it, see milestone-membership.ts). Once every task is
// Done and all their code has shipped, the tracker moves the milestone to Ready to close; a person
// closes it.

const { projects, statuses, tasks } = schema;

const keyOf = (projectKey: string, number: number) => `${projectKey}-${number}`;

/** Status, progress, tasks and the releases that shipped them, for each milestone (tasks inside `scope`). */
async function toMilestoneDtos(
  db: Db | Tx,
  scope: ProjectScope,
  milestones: TaskDto[],
): Promise<MilestoneDto[]> {
  if (milestones.length === 0) return [];
  const statusRows = await db
    .select({
      id: statuses.id,
      name: statuses.name,
      category: statuses.category,
    })
    .from(statuses)
    .where(
      inArray(statuses.id, [...new Set(milestones.map((m) => m.statusId))]),
    );
  const members = await milestoneMembers(
    db,
    scope,
    milestones.map((m) => m.id),
  );
  // Each member's shipping state and release, as on its task.
  const dtos = new Map(
    (await toTaskDtos(db, scope, members)).map((t) => [t.id, t]),
  );
  const releaseIds = [
    ...new Set(
      members.flatMap((m) => (m.task.releaseId ? [m.task.releaseId] : [])),
    ),
  ];
  const releaseRows = releaseIds.length
    ? await db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          projectId: tasks.projectId,
          projectKey: projects.key,
          shippedAt: tasks.shippedAt,
          status: {
            id: statuses.id,
            name: statuses.name,
            category: statuses.category,
          },
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .innerJoin(statuses, eq(statuses.id, tasks.statusId))
        .where(and(inArray(tasks.id, releaseIds), isNull(tasks.deletedAt)))
    : [];

  return milestones.map((milestone) => {
    const status = statusRows.find((s) => s.id === milestone.statusId);
    if (!status) throw new Error("Milestone status missing");
    const own = members.filter((m) => m.milestoneId === milestone.id);
    const releases: MilestoneReleaseDto[] = releaseRows
      .filter((r) => inScope(scope, r.projectId))
      .map((r) => ({
        id: r.id,
        key: keyOf(r.projectKey, r.number),
        title: r.title,
        status: r.status,
        shippedAt: r.shippedAt?.toISOString() ?? null,
        tasks: own
          .filter((m) => m.task.releaseId === r.id)
          .map((m) => keyOf(m.projectKey, m.task.number)),
      }))
      .filter((r) => r.tasks.length > 0)
      .sort(
        (a, b) =>
          (a.shippedAt ?? "￿").localeCompare(b.shippedAt ?? "￿") ||
          a.key.localeCompare(b.key, "en", { numeric: true }),
      );
    return {
      ...milestone,
      status,
      progress: progressOf(own),
      tasks: own.map((m): MilestoneTaskDto => ({
        id: m.task.id,
        key: keyOf(m.projectKey, m.task.number),
        title: m.task.title,
        projectKey: m.projectKey,
        status: m.status,
        parentKey: dtos.get(m.task.id)?.parentKey ?? null,
        inherited: m.inherited,
        completedAt: m.task.completedAt?.toISOString() ?? null,
        shipping: dtos.get(m.task.id)?.shipping ?? null,
      })),
      releases,
    };
  });
}

/** A milestone the viewer can see, by its task key. */
async function findMilestone(
  db: Db | Tx,
  viewer: Viewer,
  milestoneKey: string,
) {
  const found = await findTask(db, viewer, milestoneKey);
  if (found.task.kind !== "milestone") {
    throw new DomainError(
      "validation",
      `${keyOf(found.projectKey, found.task.number)} is a ${found.task.kind}, not a milestone`,
    );
  }
  return found;
}

async function milestoneDto(
  db: Db | Tx,
  viewer: Viewer,
  milestoneKey: string,
): Promise<MilestoneDto> {
  const scope = await projectScope(db, viewer);
  const [dto] = await toTaskDtos(db, scope, [
    await findMilestone(db, viewer, milestoneKey),
  ]);
  if (!dto) throw new Error("Failed to load milestone");
  const [milestone] = await toMilestoneDtos(db, scope, [dto]);
  if (!milestone) throw new Error("Failed to load milestone");
  return milestone;
}

/** One milestone by its task key, with progress, tasks and releases. */
export async function getMilestone(
  db: Db,
  viewer: Viewer,
  milestoneKey: string,
): Promise<MilestoneDto> {
  return milestoneDto(db, viewer, milestoneKey);
}

/** Roadmap order: by target date, then start date (undated ones last), then key. */
export function compareMilestones(
  a: Pick<TaskDto, "targetDate" | "startDate" | "number">,
  b: Pick<TaskDto, "targetDate" | "startDate" | "number">,
): number {
  const date = (v: string | null) => v ?? "9999-99-99";
  return (
    date(a.targetDate).localeCompare(date(b.targetDate)) ||
    date(a.startDate).localeCompare(date(b.startDate)) ||
    a.number - b.number
  );
}

/** A project's roadmap: its milestones by date (see compareMilestones), optionally by status. */
export async function listMilestones(
  db: Db,
  viewer: Viewer,
  projectKey: string,
  filters: unknown = {},
): Promise<MilestoneDto[]> {
  const { status } = parseInput(milestoneListFilters, filters);
  const project = await getProject(db, viewer, projectKey);
  const rows = await listTasks(db, viewer, project.key, {
    kind: "milestone",
    status,
  });
  rows.sort(compareMilestones);
  return toMilestoneDtos(db, await projectScope(db, viewer), rows);
}

/** Creates a milestone: a task of kind "milestone", in the first todo status of its workflow (Planned) unless `statusId` says otherwise. */
export async function createMilestone(
  db: Db,
  ctx: ActorContext,
  projectKey: string,
  input: unknown,
): Promise<MilestoneDto> {
  assertCanWrite(ctx);
  const data = parseInput(createMilestoneInput, input);
  return db.transaction(async (tx) => {
    const created = await createTaskIn(tx, ctx, projectKey, {
      kind: "milestone",
      ...data,
    });
    return milestoneDto(tx, ctx, created.key);
  });
}
