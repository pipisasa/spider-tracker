import { describe, expect, test } from "bun:test";
import { splitStack } from "./avatar-stack";

describe("splitStack", () => {
  test("shows everything up to the max", () => {
    expect(splitStack([1, 2, 3])).toEqual({ visible: [1, 2, 3], overflow: 0 });
    expect(splitStack([])).toEqual({ visible: [], overflow: 0 });
  });
  test("counts the rest as overflow", () => {
    expect(splitStack([1, 2, 3, 4, 5])).toEqual({
      visible: [1, 2, 3],
      overflow: 2,
    });
    expect(splitStack([1, 2, 3], 2)).toEqual({ visible: [1, 2], overflow: 1 });
  });
});
