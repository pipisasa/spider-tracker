import { describe, expect, test } from "bun:test";
import { actorAvatarSrc, generatedAvatarUri } from "./generated-avatar";

describe("generated avatars", () => {
  test("are deterministic per seed and differ by style", () => {
    expect(generatedAvatarUri("human", "a")).toBe(
      generatedAvatarUri("human", "a"),
    );
    expect(generatedAvatarUri("human", "a")).not.toBe(
      generatedAvatarUri("agent", "a"),
    );
    expect(generatedAvatarUri("human", "a")).toStartWith("data:image/svg+xml");
  });
  test("an own avatar url wins", () => {
    expect(
      actorAvatarSrc({ id: "a", type: "human", avatarUrl: "https://x/y.png" }),
    ).toBe("https://x/y.png");
    expect(
      actorAvatarSrc({ id: "a", type: "agent", avatarUrl: null }),
    ).toStartWith("data:");
  });
});
