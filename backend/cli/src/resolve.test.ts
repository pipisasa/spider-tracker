import { describe, expect, test } from "bun:test";
import type {
  ActorDto,
  ProjectDetailDto,
  StatusDto,
} from "@repo/core/contracts";
import { SpiderApiError } from "@repo/sdk";
import {
  matchesTaskFilter,
  EXIT,
  findWorkflowStatus,
  firstStatus,
  fromApiError,
  matchStatuses,
  parseCategory,
  parseKind,
  parsePosition,
  mineActorIds,
  parseLimit,
  parseDate,
  parsePriority,
  resolveAssignees,
  resolveStatus,
} from "./resolve";

const status = (
  id: string,
  name: string,
  category: StatusDto["category"],
  position: number,
  kind: StatusDto["kind"] = "task",
): StatusDto => ({
  id,
  kind,
  name,
  category,
  color: null,
  position,
});

const project: ProjectDetailDto = {
  id: "p",
  key: "ST",
  name: "Spider",
  description: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  rulesDocumentId: null,
  gitAutomation: {
    enabled: true,
    draft: "in_progress",
    opened: "in_review",
    merged: "done",
    closed: null,
  },
  // Deliberately out of board order.
  statuses: [
    status("review", "In Review", "in_review", 3),
    status("doing", "In Progress", "in_progress", 2),
    status("todo", "Todo", "todo", 1),
    status("blocked", "Blocked", "in_progress", 4),
    status("done", "Done", "done", 5),
  ],
  workflows: { task: [], release: [], milestone: [] },
};
project.workflows = {
  task: project.statuses,
  release: [
    status("r-planned", "Planned", "todo", 0, "release"),
    status("r-staging", "On staging", "in_progress", 1, "release"),
    status("r-done", "Released", "done", 2, "release"),
  ],
  milestone: [status("m-done", "Done", "done", 0, "milestone")],
};

const member = (id: string, handle: string): ActorDto => ({
  id,
  type: "human",
  name: handle,
  handle,
  avatarUrl: null,
  role: "member",
  deactivated: false,
  ownerId: null,
});

describe("status resolution", () => {
  test("matches names case-insensitively, then categories", () => {
    expect(resolveStatus(project, "in review").id).toBe("review");
    expect(resolveStatus(project, " TODO ").id).toBe("todo");
    expect(resolveStatus(project, "in-progress").id).toBe("doing");
    expect(matchStatuses(project, "in_progress").map((s) => s.id)).toEqual([
      "doing",
      "blocked",
    ]);
  });

  test("an unknown status is a usage error listing the valid ones", () => {
    expect(() => resolveStatus(project, "Shipped")).toThrow(
      /Valid statuses: Todo, In Progress, In Review, Blocked, Done$/,
    );
    try {
      resolveStatus(project, "Shipped");
    } catch (err) {
      expect(err).toMatchObject({ exitCode: EXIT.usage });
    }
  });

  test("firstStatus picks the category's first status in board order", () => {
    expect(firstStatus(project, "in_progress").id).toBe("doing");
    expect(firstStatus(project, "done").id).toBe("done");
    expect(() => firstStatus(project, "canceled")).toThrow(
      /no "canceled" status/,
    );
  });

  test("statuses are matched in the workflow of the task's kind (ST-90)", () => {
    expect(resolveStatus(project, "in_progress", "release").id).toBe(
      "r-staging",
    );
    expect(resolveStatus(project, "done", "milestone").id).toBe("m-done");
    expect(firstStatus(project, "done", "release").id).toBe("r-done");
    expect(() => resolveStatus(project, "Released")).toThrow(
      /Unknown status "Released" in ST\./,
    );
    expect(() => resolveStatus(project, "Backlog", "release")).toThrow(
      /in ST's release workflow\. Valid statuses: Planned, On staging, Released/,
    );
    expect(() => firstStatus(project, "in_progress", "milestone")).toThrow(
      /ST's milestone workflow has no "in_progress" status/,
    );
    // "all" spans every workflow (list filters without a kind); names still win over categories.
    expect(
      matchStatuses(project, "in_progress", "all").map((s) => s.id),
    ).toEqual(["doing", "blocked", "r-staging"]);
    expect(matchStatuses(project, "done", "all").map((s) => s.id)).toEqual([
      "done",
      "m-done",
    ]);
    // Edits name a status by id or exact name only.
    expect(findWorkflowStatus(project, "on STAGING", "release").id).toBe(
      "r-staging",
    );
    expect(findWorkflowStatus(project, "r-done", "release").id).toBe("r-done");
    expect(() => findWorkflowStatus(project, "in_progress", "release")).toThrow(
      /Unknown status/,
    );
  });

  test("servers from before kinds: statuses is the task workflow and tasks are tasks", () => {
    const old = {
      ...project,
      workflows: undefined,
    } as unknown as ProjectDetailDto;
    expect(resolveStatus(old, "in progress").id).toBe("doing");
    expect(() => resolveStatus(old, "planned", "release")).toThrow(
      /Valid statuses: $/,
    );
    const task = { statusId: "doing", assigneeIds: [], priority: 0 };
    expect(matchesTaskFilter(task, { kind: "task" })).toBe(true);
    expect(matchesTaskFilter(task, { kind: "release" })).toBe(false);
  });

  test("kinds, categories and positions as typed", () => {
    expect(parseKind(" Release ")).toBe("release");
    expect(() => parseKind("epic")).toThrow(
      /Use one of: task, release, milestone/,
    );
    expect(parseCategory("In Progress")).toBe("in_progress");
    expect(parseCategory("in-review")).toBe("in_review");
    expect(() => parseCategory("shipped")).toThrow(/Unknown category/);
    expect(parsePosition("0")).toBe(0);
    expect(() => parsePosition("-1")).toThrow(/Invalid position/);
  });
});

describe("assignee resolution", () => {
  const members = [member("a", "alice"), member("b", "bob")];

  test("accepts handles with or without @, and me", () => {
    expect(resolveAssignees(members, "me-id", ["@Alice", "bob", "me"])).toEqual(
      ["a", "b", "me-id"],
    );
    expect(resolveAssignees(members, "a", ["me", "alice"])).toEqual(["a"]);
  });

  test("an unknown handle is a usage error", () => {
    expect(() => resolveAssignees(members, "x", ["carol"])).toThrow(
      /Valid handles: me, alice, bob/,
    );
  });
});

describe('"mine" for the client-side re-check', () => {
  const agent = (
    id: string,
    ownerId: string,
    deactivated = false,
  ): ActorDto => ({
    ...member(id, id),
    type: "agent",
    ownerId,
    deactivated,
  });
  const actors = [
    member("alice", "alice"),
    member("bob", "bob"),
    agent("bot1", "alice"),
    agent("bot2", "alice"),
    agent("bot3", "bob"),
    agent("gone-alice", "alice", true),
    agent("gone-bob", "bob", true),
  ];

  test("a person: themselves and their agents, deleted ones included, not other people's", () => {
    expect(mineActorIds(member("alice", "alice"), actors).sort()).toEqual([
      "alice",
      "bot1",
      "bot2",
      "gone-alice",
    ]);
  });
  test("an agent: its owner and the owner's agents, itself included", () => {
    expect(mineActorIds(agent("bot2", "alice"), actors).sort()).toEqual([
      "alice",
      "bot1",
      "bot2",
      "gone-alice",
    ]);
    // Without ownerId on the caller, the owner comes from the actors list.
    expect(
      mineActorIds({ ...agent("bot3", "bob"), ownerId: null }, actors).sort(),
    ).toEqual(["bob", "bot3", "gone-bob"]);
  });
});

describe("parsing and error mapping", () => {
  test("priority takes 0-4 or a name", () => {
    expect(parsePriority("2")).toBe(2);
    expect(parsePriority("Urgent")).toBe(1);
    expect(() => parsePriority("5")).toThrow(/Invalid priority/);
  });

  test("dates are YYYY-MM-DD, and empty clears them", () => {
    expect(parseDate("2026-10-31", "--target")).toBe("2026-10-31");
    expect(parseDate(" ", "--start")).toBeNull();
    expect(() => parseDate("2026-02-30", "--target")).toThrow(
      'Invalid date "2026-02-30" in --target',
    );
    expect(() => parseDate("tomorrow", "--start")).toThrow(/YYYY-MM-DD/);
  });

  test("limit must be a positive integer", () => {
    expect(parseLimit("10")).toBe(10);
    expect(() => parseLimit("0")).toThrow();
    expect(() => parseLimit("ten")).toThrow();
  });

  test("API statuses map to exit codes", () => {
    const code = (status: number) =>
      fromApiError(new SpiderApiError(status, "x", "x")).exitCode;
    expect([400, 401, 403, 404, 409, 500].map(code)).toEqual([
      2, 4, 4, 3, 2, 1,
    ]);
  });
});

describe("client-side task filter (older servers ignore the query)", () => {
  const task = {
    statusId: "s-review",
    assigneeIds: ["a1"],
    tagIds: ["t-bug", "t-ui"],
    priority: 2,
  };
  test("matches every given filter, and an empty filter matches all", () => {
    expect(matchesTaskFilter(task, {})).toBe(true);
    expect(
      matchesTaskFilter(task, {
        statusIds: ["s-review"],
        assignee: ["a1"],
        tagIds: ["t-bug"],
        priority: [1, 2],
      }),
    ).toBe(true);
  });
  test("drops tasks outside the filter", () => {
    expect(matchesTaskFilter(task, { statusIds: ["s-done"] })).toBe(false);
    expect(matchesTaskFilter(task, { priority: [1] })).toBe(false);
    expect(matchesTaskFilter(task, { tagIds: ["t-bug", "t-api"] })).toBe(false);
    expect(
      matchesTaskFilter(task, { tagIds: ["t-bug", "t-api"], tagMatch: "all" }),
    ).toBe(false);
    expect(matchesTaskFilter(task, { assignee: ["a2"] })).toBe(false);
  });
  test("tagMatch any keeps tasks with at least one of the tags", () => {
    expect(
      matchesTaskFilter(task, { tagIds: ["t-bug", "t-api"], tagMatch: "any" }),
    ).toBe(true);
    expect(
      matchesTaskFilter(task, { tagIds: ["t-api"], tagMatch: "any" }),
    ).toBe(false);
  });
  test("overdue keeps open tasks past their target date; servers without dates match nothing", () => {
    const overdue = {
      statuses: [
        { id: "s-review", category: "in_review" as const },
        { id: "s-done", category: "done" as const },
      ],
      today: "2026-10-13",
    };
    expect(
      matchesTaskFilter({ ...task, targetDate: "2026-10-12" }, { overdue }),
    ).toBe(true);
    expect(
      matchesTaskFilter({ ...task, targetDate: "2026-10-13" }, { overdue }),
    ).toBe(false);
    expect(
      matchesTaskFilter(
        { ...task, statusId: "s-done", targetDate: "2026-10-12" },
        { overdue },
      ),
    ).toBe(false);
    expect(matchesTaskFilter(task, { overdue })).toBe(false);
  });

  test("none matches unassigned tasks", () => {
    expect(
      matchesTaskFilter({ ...task, assigneeIds: [] }, { assignee: ["none"] }),
    ).toBe(true);
    expect(matchesTaskFilter(task, { assignee: ["none"] })).toBe(false);
    expect(matchesTaskFilter(task, { assignee: ["none", "a1"] })).toBe(true);
  });
});

test("mine: against a server without ownerId, the re-check doesn't narrow (every actor)", () => {
  const legacy = (id: string, type: "human" | "agent") =>
    ({
      id,
      type,
      name: id,
      handle: id,
      avatarUrl: null,
      role: "member",
      deactivated: false,
    }) as unknown as ActorDto;
  const me = legacy("p1", "human");
  const ids = mineActorIds(me, [
    me,
    legacy("a1", "agent"),
    legacy("p2", "human"),
    legacy("a2", "agent"),
  ]);
  expect(ids.sort()).toEqual(["a1", "a2", "p1", "p2"]);
  // An agent caller keeps its (active, human) owner's tasks too.
  expect(
    mineActorIds(legacy("a1", "agent"), [me, legacy("a1", "agent")]).sort(),
  ).toEqual(["a1", "p1"]);
});
