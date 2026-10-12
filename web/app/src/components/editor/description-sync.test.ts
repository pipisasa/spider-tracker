import { describe, expect, test } from "bun:test";
import { descriptionToSave, remoteChange } from "./description-sync";

describe("remoteChange", () => {
  const base = { baseline: "a", draft: "a", dirty: false };
  test("unchanged server value", () =>
    expect(remoteChange({ ...base, server: "a" })).toBe("none"));
  test("null and empty are the same", () =>
    expect(remoteChange({ ...base, baseline: null, draft: "", server: "" })).toBe("none"));
  test("untouched editor loads the new value", () =>
    expect(remoteChange({ ...base, server: "b" })).toBe("remount"));
  test("own save echoed back", () =>
    expect(remoteChange({ baseline: "a", draft: "mine", dirty: true, server: "mine" })).toBe("adopt"));
  test("someone else changed it under an edit", () =>
    expect(remoteChange({ baseline: "a", draft: "mine", dirty: true, server: "theirs" })).toBe("conflict"));
});

describe("descriptionToSave", () => {
  test("never saves without an edit", () =>
    expect(descriptionToSave({ dirty: false, draft: "stale", server: "fresh" })).toBeUndefined());
  test("saves an edit", () =>
    expect(descriptionToSave({ dirty: true, draft: "new", server: "old" })).toBe("new"));
  test("skips an edit that equals the server value", () =>
    expect(descriptionToSave({ dirty: true, draft: "same", server: "same" })).toBeUndefined());
  test("clearing saves null", () =>
    expect(descriptionToSave({ dirty: true, draft: "  ", server: "old" })).toBeNull());
  test("clearing an empty description is a no-op", () =>
    expect(descriptionToSave({ dirty: true, draft: "", server: null })).toBeUndefined());
});
