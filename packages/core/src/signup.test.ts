import { describe, expect, test } from "bun:test";
import { isEmailAllowed, isSignupAllowed, parseAllowlist } from "./signup";

describe("sign-up allowlist", () => {
  const list = parseAllowlist(" Alice@Example.com, @batele.plus\n@users.batele-id.invalid ");

  test("parses emails and domains", () => {
    expect(list).toEqual(["alice@example.com", "@batele.plus", "@users.batele-id.invalid"]);
  });

  test("matches exact emails and whole domains only", () => {
    expect(isEmailAllowed("ALICE@example.com", list)).toBe(true);
    expect(isEmailAllowed("bob@batele.plus", list)).toBe(true);
    expect(isEmailAllowed("123@users.batele-id.invalid", list)).toBe(true);
    expect(isEmailAllowed("bob@example.com", list)).toBe(false);
    expect(isEmailAllowed("bob@evil-batele.plus", list)).toBe(false);
    expect(isEmailAllowed("bob@sub.batele.plus", list)).toBe(false);
  });

  test("an empty list allows everyone", () => {
    expect(isEmailAllowed("anyone@example.com", parseAllowlist(""))).toBe(true);
  });

  test("sign-ups need a listed address that was verified", () => {
    expect(isSignupAllowed({ email: "bob@batele.plus", emailVerified: true }, list)).toBe(true);
    expect(isSignupAllowed({ email: "bob@batele.plus", emailVerified: false }, list)).toBe(false);
    expect(isSignupAllowed({ email: "bob@example.com", emailVerified: true }, list)).toBe(false);
    expect(isSignupAllowed({ email: "anyone@example.com", emailVerified: false }, parseAllowlist(""))).toBe(true);
  });
});
