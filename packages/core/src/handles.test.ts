import { describe, expect, test } from "bun:test";
import { handleFrom, slugFrom } from "./handles";

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
