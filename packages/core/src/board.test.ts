import { describe, expect, test } from "bun:test";
import { boardColumns, milestoneProgressLabel, shippingLabel } from "./board";
import type { StatusDto } from "./contracts";

const status = (id: string, kind: StatusDto["kind"], name: string, category: StatusDto["category"], position: number): StatusDto => ({
  id,
  kind,
  name,
  category,
  color: null,
  position,
});

const task = [status("t1", "task", "In Progress", "in_progress", 0), status("t2", "task", "Done", "done", 1)];
const release = [status("r1", "release", "Planned", "todo", 0), status("r2", "release", "Released", "done", 1)];
const project = { statuses: task, workflows: { task, release, milestone: [] } };

describe("boardColumns (ST-93)", () => {
  test("task columns, then a column per release status with its releases in sort order", () => {
    const columns = boardColumns(
      project,
      [{ statusId: "t2", sortKey: "b", key: "ST-2" }, { statusId: "t2", sortKey: "a", key: "ST-1" }],
      [{ statusId: "r2", sortKey: "a", key: "ST-9" }, { statusId: "gone", sortKey: "a", key: "ST-8" }],
    );
    expect(columns.map((c) => [c.type, c.status.name, c.type === "tasks" ? c.tasks.map((t) => t.key) : c.releases.map((r) => r.key)])).toEqual([
      ["tasks", "In Progress", []],
      ["tasks", "Done", ["ST-1", "ST-2"]],
      ["releases", "Planned", []],
      ["releases", "Released", ["ST-9"]],
    ]);
  });

  test("release columns can be turned off", () => {
    expect(boardColumns(project, [], [], { releaseColumns: false }).map((c) => c.type)).toEqual(["tasks", "tasks"]);
  });
});

describe("shippingLabel (ST-93)", () => {
  const ref = { id: "r", key: "ST-9", title: "2026.10.14", status: { id: "r1", name: "On staging", category: "in_progress" as const } };
  test.each([
    [null, null],
    [{ state: "not_in_release" as const, release: null }, "not in a release"],
    [{ state: "no_code" as const, release: null }, "no code"],
    [{ state: "in_release" as const, release: ref }, "2026.10.14 · on staging"],
    [{ state: "in_release" as const, release: null }, "in a release"],
    [{ state: "shipped" as const, release: ref }, "shipped 2026.10.14"],
  ])("%j → %s", (shipping, label) => expect(shippingLabel(shipping)).toBe(label));
});

describe("milestoneProgressLabel (ST-96)", () => {
  const p = (total: number, done: number, withCode: number, shipped: number) => ({ total, done, canceled: 0, withCode, shipped, complete: false });
  test.each([
    [p(0, 0, 0, 0), "no tasks"],
    [p(5, 3, 0, 0), "3/5 done"],
    [p(5, 3, 2, 1), "3/5 done · 1/2 shipped"],
  ])("%j → %s", (progress, label) => expect(milestoneProgressLabel(progress)).toBe(label));
});
