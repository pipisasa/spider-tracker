import { describe, expect, test } from "bun:test";
import { afterSave, descriptionToSave, remoteChange } from "./description-sync";

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

describe("save in flight", () => {
  const flight = { baseline: "a", draft: "mine", dirty: true, saving: "mine" };
  test("optimistic echo is not adopted", () =>
    expect(remoteChange({ ...flight, server: "mine" })).toBe("none"));
  test("failed save: rollback keeps the draft, still dirty", () => {
    // echo while in flight, then the cache rolls back to the baseline
    expect(remoteChange({ ...flight, server: "mine" })).toBe("none");
    expect(remoteChange({ ...flight, server: "a" })).toBe("none");
    // nothing reset the draft, so a retry on blur still saves it
    expect(descriptionToSave({ dirty: true, draft: "mine", server: "a" })).toBe("mine");
  });
  test("someone else's change during a save is still a conflict", () =>
    expect(remoteChange({ ...flight, server: "theirs" })).toBe("conflict"));
  test("success: baseline moves, clean", () => {
    expect(afterSave({ saved: "mine", draft: "mine" })).toEqual({ baseline: "mine", dirty: false });
    // the settled server value now equals the baseline
    expect(remoteChange({ baseline: "mine", draft: "mine", dirty: false, server: "mine" })).toBe("none");
  });
  test("success while the user kept typing stays dirty", () =>
    expect(afterSave({ saved: "mine", draft: "mine more" })).toEqual({ baseline: "mine", dirty: true }));
  test("saving null clears", () =>
    expect(afterSave({ saved: null, draft: "" })).toEqual({ baseline: null, dirty: false }));
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
