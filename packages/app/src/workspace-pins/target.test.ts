import { describe, expect, it } from "vitest";
import { isTargetPinned, pinnedTargetKey, togglePinnedTarget } from "./target";

describe("pinnedTargetKey", () => {
  it("uses the bare kind as the key for non-profile targets", () => {
    expect(pinnedTargetKey({ kind: "draft" })).toBe("draft");
    expect(pinnedTargetKey({ kind: "terminal" })).toBe("terminal");
    expect(pinnedTargetKey({ kind: "browser" })).toBe("browser");
  });

  it("namespaces a profile target by its profile id", () => {
    expect(pinnedTargetKey({ kind: "profile", profileId: "claude" })).toBe("profile:claude");
  });

  it("gives two profiles with different ids different keys", () => {
    const claude = pinnedTargetKey({ kind: "profile", profileId: "claude" });
    const codex = pinnedTargetKey({ kind: "profile", profileId: "codex" });
    expect(claude).not.toBe(codex);
  });
});

describe("togglePinnedTarget / isTargetPinned", () => {
  it("pins a target that is not yet pinned", () => {
    const pinned = togglePinnedTarget([], { kind: "terminal" });
    expect(isTargetPinned(pinned, { kind: "terminal" })).toBe(true);
  });

  it("unpins a target that is already pinned", () => {
    const pinned = togglePinnedTarget([{ kind: "browser" }], { kind: "browser" });
    expect(isTargetPinned(pinned, { kind: "browser" })).toBe(false);
  });

  it("treats profiles with different ids as independent pins", () => {
    const pinned = togglePinnedTarget([], { kind: "profile", profileId: "claude" });
    expect(isTargetPinned(pinned, { kind: "profile", profileId: "claude" })).toBe(true);
    expect(isTargetPinned(pinned, { kind: "profile", profileId: "codex" })).toBe(false);
  });

  it("unpins only the matching profile id", () => {
    let pinned = togglePinnedTarget([], { kind: "profile", profileId: "claude" });
    pinned = togglePinnedTarget(pinned, { kind: "profile", profileId: "codex" });
    pinned = togglePinnedTarget(pinned, { kind: "profile", profileId: "claude" });

    expect(isTargetPinned(pinned, { kind: "profile", profileId: "claude" })).toBe(false);
    expect(isTargetPinned(pinned, { kind: "profile", profileId: "codex" })).toBe(true);
  });
});
