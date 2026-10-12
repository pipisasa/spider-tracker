import { describe, expect, test } from "bun:test";
import {
  EMPTY_SEQUENCE,
  advanceSequence,
  isEditableElement,
  isPaletteKey,
  parseTaskKey,
  projectKeyOfTask,
  shortcutKey,
  type ShortcutDef,
} from "./shortcuts";

const attrs = (map: Record<string, string>) => (name: string) => map[name] ?? null;

describe("shortcutKey", () => {
  test("lower-cases plain keys and keeps symbols", () => {
    expect(shortcutKey({ key: "C" })).toBe("c");
    expect(shortcutKey({ key: "?", shiftKey: true } as { key: string })).toBe("?");
  });
  test("ignores modified presses and named keys", () => {
    expect(shortcutKey({ key: "c", metaKey: true })).toBeNull();
    expect(shortcutKey({ key: "c", ctrlKey: true })).toBeNull();
    expect(shortcutKey({ key: "c", altKey: true })).toBeNull();
    expect(shortcutKey({ key: "Shift" })).toBeNull();
    expect(shortcutKey({ key: "Escape" })).toBeNull();
  });
});

describe("isPaletteKey", () => {
  test("matches cmd/ctrl + k only", () => {
    expect(isPaletteKey({ key: "k", metaKey: true })).toBe(true);
    expect(isPaletteKey({ key: "K", ctrlKey: true })).toBe(true);
    expect(isPaletteKey({ key: "k" })).toBe(false);
    expect(isPaletteKey({ key: "j", metaKey: true })).toBe(false);
    expect(isPaletteKey({ key: "k", metaKey: true, shiftKey: true })).toBe(false);
  });
});

describe("advanceSequence", () => {
  test("a single key completes immediately", () => {
    expect(advanceSequence(EMPTY_SEQUENCE, "c", 0).matched).toBe("new-task");
    expect(advanceSequence(EMPTY_SEQUENCE, "?", 0).matched).toBe("help");
  });
  test("g then b completes a sequence", () => {
    const first = advanceSequence(EMPTY_SEQUENCE, "g", 100);
    expect(first.matched).toBeNull();
    expect(first.state.keys).toEqual(["g"]);
    const second = advanceSequence(first.state, "b", 600);
    expect(second.matched).toBe("go-board");
    expect(second.state).toEqual(EMPTY_SEQUENCE);
  });
  test("the prefix expires after the timeout", () => {
    const first = advanceSequence(EMPTY_SEQUENCE, "g", 0);
    expect(advanceSequence(first.state, "b", 1001).matched).toBeNull();
    expect(advanceSequence(first.state, "b", 1000).matched).toBe("go-board");
  });
  test("an expired prefix does not swallow a later single key", () => {
    const first = advanceSequence(EMPTY_SEQUENCE, "g", 0);
    expect(advanceSequence(first.state, "c", 5000).matched).toBe("new-task");
  });
  test("a key that breaks the sequence starts over", () => {
    const first = advanceSequence(EMPTY_SEQUENCE, "g", 0);
    expect(advanceSequence(first.state, "z", 10)).toEqual({ state: EMPTY_SEQUENCE, matched: null });
    expect(advanceSequence(first.state, "c", 10).matched).toBe("new-task");
    const again = advanceSequence(first.state, "g", 10);
    expect(again.state.keys).toEqual(["g"]);
  });
  test("unknown keys do nothing", () => {
    expect(advanceSequence(EMPTY_SEQUENCE, "x", 0)).toEqual({ state: EMPTY_SEQUENCE, matched: null });
  });
  test("supports custom definitions and three-key sequences", () => {
    const defs: ShortcutDef[] = [{ id: "help", keys: ["a", "b", "c"], label: "x", group: "General" }];
    let state = advanceSequence(EMPTY_SEQUENCE, "a", 0, defs).state;
    state = advanceSequence(state, "b", 1, defs).state;
    expect(advanceSequence(state, "c", 2, defs).matched).toBe("help");
  });
});

describe("isEditableElement", () => {
  test("text fields are editable", () => {
    expect(isEditableElement({ tagName: "INPUT", getAttribute: attrs({}) })).toBe(true);
    expect(isEditableElement({ tagName: "INPUT", getAttribute: attrs({ type: "search" }) })).toBe(true);
    expect(isEditableElement({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableElement({ tagName: "SELECT" })).toBe(true);
  });
  test("buttons and checkboxes are not", () => {
    expect(isEditableElement({ tagName: "INPUT", getAttribute: attrs({ type: "checkbox" }) })).toBe(false);
    expect(isEditableElement({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableElement({ tagName: "DIV" })).toBe(false);
  });
  test("contenteditable and textbox roles are editable", () => {
    expect(isEditableElement({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableElement({ tagName: "DIV", getAttribute: attrs({ contenteditable: "" }) })).toBe(true);
    expect(isEditableElement({ tagName: "DIV", getAttribute: attrs({ contenteditable: "false" }) })).toBe(false);
    expect(isEditableElement({ tagName: "DIV", getAttribute: attrs({ role: "textbox" }) })).toBe(true);
  });
  test("no target is not editable", () => {
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(undefined)).toBe(false);
  });
});

describe("task keys", () => {
  test("parseTaskKey normalises", () => {
    expect(parseTaskKey("st-12")).toBe("ST-12");
    expect(parseTaskKey("  ST-3 ")).toBe("ST-3");
    expect(parseTaskKey("ab2-7")).toBe("AB2-7");
  });
  test("parseTaskKey rejects other text", () => {
    expect(parseTaskKey("st")).toBeNull();
    expect(parseTaskKey("st-")).toBeNull();
    expect(parseTaskKey("fix the bug")).toBeNull();
    expect(parseTaskKey("12-3")).toBeNull();
  });
  test("projectKeyOfTask", () => {
    expect(projectKeyOfTask("ST-12")).toBe("ST");
  });
});

test("non-Latin layouts fall back to the physical key", () => {
  expect(shortcutKey({ key: "с", code: "KeyC" })).toBe("c");
  expect(shortcutKey({ key: "п", code: "KeyG" })).toBe("g");
  expect(shortcutKey({ key: "?", code: "Slash" })).toBe("?");
  expect(shortcutKey({ key: "c", code: "KeyC" })).toBe("c");
  expect(isPaletteKey({ key: "л", code: "KeyK", metaKey: true })).toBe(true);
});
