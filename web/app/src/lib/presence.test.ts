import { describe, expect, test } from "bun:test";
import { PRESENCE_WINDOW_MS, isWorkingNow, workingActorIds } from "./presence";

const at = (ms: number) => new Date(ms).toISOString();

describe("isWorkingNow", () => {
  const seen = Date.parse("2026-01-01T12:00:00Z");

  test("is active until ten minutes have passed", () => {
    expect(isWorkingNow(at(seen), seen)).toBe(true);
    expect(isWorkingNow(at(seen), seen + PRESENCE_WINDOW_MS - 1)).toBe(true);
    expect(isWorkingNow(at(seen), seen + PRESENCE_WINDOW_MS)).toBe(false);
  });

  test("ignores unparseable times", () => {
    expect(isWorkingNow("nope", seen)).toBe(false);
  });
});

describe("workingActorIds", () => {
  const now = Date.parse("2026-01-01T12:30:00Z");
  const items = [
    { taskKey: "ST-1", actorId: "a", lastSeenAt: at(now - 60_000) },
    { taskKey: "ST-1", actorId: "b", lastSeenAt: at(now - 11 * 60_000) },
    { taskKey: "ST-2", actorId: "c", lastSeenAt: at(now) },
  ];

  test("lists the recent agents of one task, and expires them as the clock advances", () => {
    expect(workingActorIds(items, "ST-1", now)).toEqual(["a"]);
    expect(workingActorIds(items, "ST-1", now + 9 * 60_000)).toEqual([]);
    expect(workingActorIds(items, "ST-3", now)).toEqual([]);
  });
});
