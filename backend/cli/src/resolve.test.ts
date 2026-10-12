import { describe, expect, test } from "bun:test";
import type { ActorDto, ProjectDetailDto, StatusDto } from "@repo/core/contracts";
import { SpiderApiError } from "@repo/sdk";
import {
  EXIT,
  firstStatus,
  fromApiError,
  matchStatuses,
  parseLimit,
  parsePriority,
  resolveAssignees,
  resolveStatus,
} from "./resolve";

const status = (id: string, name: string, category: StatusDto["category"], position: number): StatusDto => ({
  id,
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
  // Deliberately out of board order.
  statuses: [
    status("review", "In Review", "in_review", 3),
    status("doing", "In Progress", "in_progress", 2),
    status("todo", "Todo", "todo", 1),
    status("blocked", "Blocked", "in_progress", 4),
    status("done", "Done", "done", 5),
  ],
};

const member = (id: string, handle: string): ActorDto => ({
  id,
  type: "human",
  name: handle,
  handle,
  avatarUrl: null,
  role: "member",
});

describe("status resolution", () => {
  test("matches names case-insensitively, then categories", () => {
    expect(resolveStatus(project, "in review").id).toBe("review");
    expect(resolveStatus(project, " TODO ").id).toBe("todo");
    expect(resolveStatus(project, "in-progress").id).toBe("doing");
    expect(matchStatuses(project, "in_progress").map((s) => s.id)).toEqual(["doing", "blocked"]);
  });

  test("an unknown status is a usage error listing the valid ones", () => {
    expect(() => resolveStatus(project, "Shipped")).toThrow(/Valid statuses: In Review, In Progress, Todo/);
    try {
      resolveStatus(project, "Shipped");
    } catch (err) {
      expect(err).toMatchObject({ exitCode: EXIT.usage });
    }
  });

  test("firstStatus picks the category's first status in board order", () => {
    expect(firstStatus(project, "in_progress").id).toBe("doing");
    expect(firstStatus(project, "done").id).toBe("done");
    expect(() => firstStatus(project, "canceled")).toThrow(/no "canceled" status/);
  });
});

describe("assignee resolution", () => {
  const members = [member("a", "alice"), member("b", "bob")];

  test("accepts handles with or without @, and me", () => {
    expect(resolveAssignees(members, "me-id", ["@Alice", "bob", "me"])).toEqual(["a", "b", "me-id"]);
    expect(resolveAssignees(members, "a", ["me", "alice"])).toEqual(["a"]);
  });

  test("an unknown handle is a usage error", () => {
    expect(() => resolveAssignees(members, "x", ["carol"])).toThrow(/Valid handles: me, alice, bob/);
  });
});

describe("parsing and error mapping", () => {
  test("priority takes 0-4 or a name", () => {
    expect(parsePriority("2")).toBe(2);
    expect(parsePriority("Urgent")).toBe(1);
    expect(() => parsePriority("5")).toThrow(/Invalid priority/);
  });

  test("limit must be a positive integer", () => {
    expect(parseLimit("10")).toBe(10);
    expect(() => parseLimit("0")).toThrow();
    expect(() => parseLimit("ten")).toThrow();
  });

  test("API statuses map to exit codes", () => {
    const code = (status: number) => fromApiError(new SpiderApiError(status, "x", "x")).exitCode;
    expect([400, 401, 403, 404, 409, 500].map(code)).toEqual([2, 4, 4, 3, 2, 1]);
  });
});
