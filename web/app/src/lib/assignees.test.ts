import { describe, expect, test } from "bun:test";
import type { ActorDto } from "@repo/core/contracts";
import {
  actorLabel,
  assigneeOptions,
  mentionOf,
  nameOf,
  assigneesOf,
  toggleAssignee,
} from "./assignees";

const actor = (id: string, deactivated = false): ActorDto => ({
  id,
  type: "agent",
  name: id,
  handle: id,
  avatarUrl: null,
  role: "member",
  deactivated,
  ownerId: null,
});
const alice = actor("alice");
const bob = actor("bob");
const gone = actor("gone", true);
const other = actor("other", true);

describe("assignees", () => {
  test("labels deactivated actors", () => {
    expect(actorLabel(alice)).toBe("alice");
    expect(actorLabel(gone)).toBe("gone (deactivated)");
  });

  test("resolves ids in order and skips unknown ones", () => {
    const map = new Map([alice, gone].map((a) => [a.id, a]));
    expect(assigneesOf(["gone", "missing", "alice"], map)).toEqual([
      gone,
      alice,
    ]);
  });

  test("the picker lists active members plus deactivated assignees only", () => {
    const { selected, options } = assigneeOptions(
      [alice, bob],
      [alice, bob, gone, other],
      ["gone", "alice"],
    );
    expect(selected).toEqual([gone, alice]);
    expect(options).toEqual([alice, bob, gone]);
  });

  test("without the full actor list, selected members still resolve", () => {
    expect(assigneeOptions([alice, bob], [], ["bob", "gone"]).selected).toEqual(
      [bob],
    );
  });

  test("deactivated assignees can be removed but not added", () => {
    expect(toggleAssignee(["gone", "alice"], gone)).toEqual(["alice"]);
    expect(toggleAssignee(["alice"], gone)).toEqual(["alice"]);
    expect(toggleAssignee(["alice"], bob)).toEqual(["alice", "bob"]);
  });
});

describe("display names", () => {
  test("nameOf marks deactivated actors and falls back when unknown", () => {
    expect(nameOf(alice, "Unknown")).toBe("alice");
    expect(nameOf(gone, "Unknown")).toBe("gone (deactivated)");
    expect(nameOf(undefined, "Unknown")).toBe("Unknown");
  });
  test("mentionOf", () => {
    expect(mentionOf(alice)).toBe("@alice");
    expect(mentionOf(gone)).toBe("@gone (deactivated)");
    expect(mentionOf(undefined)).toBe("@unknown");
  });
});
