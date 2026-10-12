import { expect, test } from "bun:test";
import type { ActivityDto } from "@repo/core/contracts";
import { describeActivity } from "./task-comments";

const update = (changes: Record<string, unknown>): ActivityDto => ({
  id: 1,
  action: "task.updated",
  changes,
  source: "ui",
  actorId: "a",
  createdAt: "2026-10-12T00:00:00.000Z",
});
const tags = new Map([
  ["t1", "bug"],
  ["t2", "ui"],
]);

test("tag edits name the added and removed tags", () => {
  const describe = (from: string[], to: string[]) => describeActivity(update({ tagIds: [from, to] }), [], new Map(), tags);
  expect(describe([], ["t1"])).toBe("added tag bug");
  expect(describe([], ["t1", "t2"])).toBe("added tags bug, ui");
  expect(describe(["t1"], ["t2"])).toBe("added tag ui, removed tag bug");
  expect(describe(["t1", "gone"], [])).toBe("removed tag bug and 1 deleted tag");
  expect(describe(["t1"], ["t1"])).toBe("changed tags");
});

test("date edits name the new date, or say it was removed (ST-91)", () => {
  const describe = (changes: Record<string, unknown>) => describeActivity(update(changes), [], new Map(), tags);
  // Formatted in the viewer's locale, with the year outside the current one.
  expect(describe({ targetDate: [null, "2020-03-01"] })).toMatch(/^set the target date to .*2020/);
  expect(describe({ startDate: ["2020-01-01", null] })).toBe("removed the start date");
});
