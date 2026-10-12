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
  expect(describe([], ["t1"])).toBe("added bug tag");
  expect(describe(["t1"], ["t2"])).toBe("added ui, removed bug tags");
  expect(describe(["t1", "gone"], [])).toBe("removed bug, a deleted tag tags");
  expect(describe(["t1"], ["t1"])).toBe("changed tags");
});
