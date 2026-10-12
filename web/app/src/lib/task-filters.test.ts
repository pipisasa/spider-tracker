import { describe, expect, test } from "bun:test";
import type { ActorDto, TaskDto } from "@repo/core/contracts";
import {
  activeFilterCount,
  applyFilters,
  filtersToSearch,
  mineActorIds,
  normalizeFilters,
  parseFilters,
  sameFilters,
  toggleValue,
} from "./task-filters";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ME = id(100);

function task(n: number, extra: Partial<TaskDto> = {}): TaskDto {
  return {
    id: id(n),
    key: `SPI-${n}`,
    number: n,
    projectId: id(900),
    title: `Task ${n}`,
    description: null,
    statusId: id(1),
    priority: 0,
    parentId: null,
    parentKey: null,
    sortKey: "a",
    startDate: null,
    targetDate: null,
    assigneeIds: [],
    tagIds: [],
    creatorId: ME,
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    subtasks: null,
    releaseId: null,
    shippedAt: null,
    noCode: false,
    shipping: null,
    ...extra,
  };
}

describe("parseFilters", () => {
  test("reads arrays, single values and numeric strings; drops malformed ones", () => {
    expect(
      parseFilters({ status: id(1), assignee: ["me", "mine", "none", id(2), "bob"], priority: ["1", 3, 9, "x"], tag: [id(5), id(5), "nope"], q: " bug " }),
    ).toEqual({ status: [id(1)], assignee: ["me", "mine", "none", id(2)], priority: [1, 3], tag: [id(5)], q: "bug" });
  });

  test("empty and unknown input yields no filters; numeric q (JSON-parsed by the router) is kept", () => {
    expect(parseFilters({})).toEqual({});
    expect(parseFilters({ view: "list", status: [], q: "  " })).toEqual({});
    expect(parseFilters({ q: 123 })).toEqual({ q: "123" });
  });

  test("filtersToSearch drops empty keys and round-trips", () => {
    const filters = { assignee: ["me"], priority: [0 as const, 2 as const], status: [] };
    expect(filtersToSearch(filters)).toEqual({ assignee: ["me"], priority: [0, 2] });
    expect(parseFilters(filtersToSearch(filters))).toEqual(filtersToSearch(filters));
  });

  test("normalizeFilters tolerates junk from storage", () => {
    expect(normalizeFilters({ priority: [9] })).toEqual({});
    expect(normalizeFilters("x")).toEqual({});
    expect(normalizeFilters({ tag: [id(3)] })).toEqual({ tag: [id(3)] });
    expect(normalizeFilters({ assignee: ["mine", "none"] })).toEqual({ assignee: ["mine", "none"] });
  });

  test("tagMatch: only any is kept in the URL; junk is dropped", () => {
    expect(parseFilters({ tag: id(3), tagMatch: "any" })).toEqual({ tag: [id(3)], tagMatch: "any" });
    expect(parseFilters({ tagMatch: "all" })).toEqual({});
    expect(parseFilters({ tagMatch: "some" })).toEqual({});
    expect(normalizeFilters({ tag: [id(3)], tagMatch: "any" })).toEqual({ tag: [id(3)], tagMatch: "any" });
  });
});

describe("helpers", () => {
  test("activeFilterCount, sameFilters and toggleValue", () => {
    expect(activeFilterCount({ status: [id(1), id(2)], q: "x" })).toBe(3);
    expect(sameFilters({ status: [id(1), id(2)], q: "Bug" }, { q: "bug ", status: [id(2), id(1)] })).toBe(true);
    expect(sameFilters({ status: [id(1)] }, {})).toBe(false);
    expect(sameFilters({ tag: [id(1), id(2)], tagMatch: "all" }, { tag: [id(2), id(1)] })).toBe(true);
    expect(sameFilters({ tag: [id(1), id(2)], tagMatch: "any" }, { tag: [id(1), id(2)] })).toBe(false);
    expect(sameFilters({ tag: [id(1)], tagMatch: "any" }, { tag: [id(1)] })).toBe(true);
    expect(toggleValue(undefined, 1)).toEqual([1]);
    expect(toggleValue([1, 2], 1)).toEqual([2]);
  });
});

describe("applyFilters", () => {
  const tasks = [
    task(1, { statusId: id(1), priority: 1, assigneeIds: [ME], tagIds: [id(50)], title: "Fix login bug" }),
    task(2, { statusId: id(2), priority: 2, assigneeIds: [id(101)], tagIds: [id(51)] }),
    task(3, { statusId: id(2), priority: 0, assigneeIds: [], tagIds: [id(50), id(51)] }),
    task(4, { statusId: id(3), priority: 3, assigneeIds: [ME, id(101)] }),
  ];
  const keys = (f: Parameters<typeof applyFilters>[1]) => applyFilters(tasks, f, ME).map((t) => t.key);

  test("no filters returns every task", () => {
    expect(keys({})).toEqual(["SPI-1", "SPI-2", "SPI-3", "SPI-4"]);
  });

  test("status and priority are OR within the key", () => {
    expect(keys({ status: [id(2), id(3)] })).toEqual(["SPI-2", "SPI-3", "SPI-4"]);
    expect(keys({ priority: [0, 1] })).toEqual(["SPI-1", "SPI-3"]);
  });

  test("assignee: me, none, specific actors", () => {
    expect(keys({ assignee: ["me"] })).toEqual(["SPI-1", "SPI-4"]);
    expect(keys({ assignee: ["none"] })).toEqual(["SPI-3"]);
    expect(keys({ assignee: ["none", id(101)] })).toEqual(["SPI-2", "SPI-3", "SPI-4"]);
  });

  test("assignee mine: the viewer and the agents they own (deleted ones too), not other people's", () => {
    const actor = (n: number, type: ActorDto["type"], ownerId: string | null, deactivated = false): ActorDto => ({
      id: id(n),
      type,
      name: `Actor ${n}`,
      handle: `actor-${n}`,
      avatarUrl: null,
      role: "member",
      deactivated,
      ownerId,
    });
    const actors = [
      actor(100, "human", null),
      actor(101, "human", null),
      actor(102, "agent", ME),
      actor(103, "agent", id(101)),
      actor(104, "agent", ME, true),
      actor(105, "agent", id(101), true),
    ];
    const mine = mineActorIds(ME, actors);
    expect(mine).toEqual([ME, id(102), id(104)]);
    const all = [
      ...tasks,
      task(5, { assigneeIds: [id(102)] }),
      task(6, { assigneeIds: [id(103)] }),
      task(7, { assigneeIds: [id(104)] }),
      task(8, { assigneeIds: [id(105)] }),
    ];
    expect(applyFilters(all, { assignee: ["mine"] }, ME, mine).map((t) => t.key)).toEqual(["SPI-1", "SPI-4", "SPI-5", "SPI-7"]);
    expect(applyFilters(all, { assignee: ["mine", "none"] }, ME, mine).map((t) => t.key)).toEqual([
      "SPI-1",
      "SPI-3",
      "SPI-4",
      "SPI-5",
      "SPI-7",
    ]);
    // Without the agents (not loaded yet), mine is just the viewer.
    expect(applyFilters(all, { assignee: ["mine"] }, ME).map((t) => t.key)).toEqual(["SPI-1", "SPI-4"]);
  });

  test("overdue: open tasks whose target date is before today; parsed from the URL and counted", () => {
    const statuses = [
      { id: id(1), category: "todo" as const },
      { id: id(2), category: "done" as const },
      { id: id(3), category: "canceled" as const },
    ];
    const dated = [
      task(1, { targetDate: "2026-10-12" }),
      task(2, { targetDate: "2026-10-13" }),
      task(3, { targetDate: "2026-10-01", statusId: id(2) }),
      task(4, { targetDate: "2026-10-01", statusId: id(3) }),
      task(5),
    ];
    expect(applyFilters(dated, { overdue: true }, ME, [ME], statuses, "2026-10-13").map((t) => t.key)).toEqual(["SPI-1"]);
    expect(applyFilters(dated, { overdue: true, q: "nope" }, ME, [ME], statuses, "2026-10-13")).toEqual([]);
    expect(parseFilters({ overdue: true })).toEqual({ overdue: true });
    expect(parseFilters({ overdue: "true" })).toEqual({ overdue: true });
    expect(parseFilters({ overdue: false })).toEqual({});
    expect(activeFilterCount({ overdue: true })).toBe(1);
    expect(sameFilters({ overdue: true }, {})).toBe(false);
    expect(normalizeFilters({ overdue: true, q: "x" })).toEqual({ overdue: true, q: "x" });
  });

  test("tag matches all chosen tags by default, any with tagMatch any", () => {
    expect(keys({ tag: [id(51)] })).toEqual(["SPI-2", "SPI-3"]);
    expect(keys({ tag: [id(50), id(51)] })).toEqual(["SPI-3"]);
    expect(keys({ tag: [id(50), id(51)], tagMatch: "all" })).toEqual(["SPI-3"]);
    expect(keys({ tag: [id(50), id(51)], tagMatch: "any" })).toEqual(["SPI-1", "SPI-2", "SPI-3"]);
  });

  test("text matches title or key, case-insensitively; keys are AND-ed", () => {
    expect(keys({ q: "LOGIN" })).toEqual(["SPI-1"]);
    expect(keys({ q: "spi-3" })).toEqual(["SPI-3"]);
    expect(keys({ status: [id(2)], assignee: ["me"] })).toEqual([]);
    expect(keys({ status: [id(2)], tag: [id(50)] })).toEqual(["SPI-3"]);
  });
});
