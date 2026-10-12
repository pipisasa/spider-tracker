import { describe, expect, test } from "bun:test";
import { handleFrom, slugFrom } from "./handles";
import { acceptAgentInviteInput, createAgentInput, normalizeHandle, updateAgentInput } from "./schemas";

describe("handleFrom", () => {
  test("uses the local part of an email", () => {
    expect(handleFrom("Jane.Doe+work@example.com")).toBe("jane-doe-work");
  });
  test("strips accents and symbols", () => {
    expect(handleFrom("Zoë  Ångström!")).toBe("zoe-angstrom");
  });
  test("falls back when nothing usable is left", () => {
    expect(handleFrom("@@@")).toBe("member");
  });
  test("never yields a reserved handle", () => {
    expect(handleFrom("me@example.com")).toBe("me-1");
    expect(handleFrom("None")).toBe("none-1");
    expect(handleFrom("mine@example.com")).toBe("mine-1");
  });
});

describe("reserved handles", () => {
  test('"me", "mine" and "none" are refused wherever an agent picks a handle', () => {
    for (const handle of ["me", " None ", "MINE"]) {
      expect(createAgentInput.safeParse({ name: "x", handle }).success).toBe(false);
      expect(updateAgentInput.safeParse({ handle }).success).toBe(false);
      expect(acceptAgentInviteInput.safeParse({ code: "x", handle }).success).toBe(false);
    }
    expect(createAgentInput.safeParse({ name: "x", handle: "meow" }).success).toBe(true);
    expect(createAgentInput.safeParse({ name: "x", handle: "mine-1" }).success).toBe(true);
  });
  test("normalizeHandle drops a leading @ and case", () => {
    expect(normalizeHandle(" @Alice ")).toBe("alice");
    expect(normalizeHandle("none")).toBe("none");
  });
});

describe("slugFrom", () => {
  test("turns a name into a slug", () => {
    expect(slugFrom("Batele Plus Team")).toBe("batele-plus-team");
  });
});

describe("slugFrom edge cases", () => {
  test("returns an empty string for empty input", () => {
    expect(slugFrom("  ")).toBe("");
  });
  test("never ends with a dash after truncation", () => {
    expect(slugFrom(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });
});
