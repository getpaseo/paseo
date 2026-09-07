import { describe, expect, it } from "vitest";
import {
  mergeHiddenFromTrack,
  resolveHiddenTrackStorage,
  serializeHiddenFromTrack,
} from "./hidden-track-persistence";

describe("serializeHiddenFromTrack", () => {
  it("converts the hidden set into a plain array for storage", () => {
    expect(serializeHiddenFromTrack(new Set(["a", "b"]))).toEqual({
      hiddenFromTrack: ["a", "b"],
    });
  });
});

describe("mergeHiddenFromTrack", () => {
  it("restores a persisted hidden set", () => {
    const current = { hiddenFromTrack: new Set<string>() };
    const merged = mergeHiddenFromTrack({ hiddenFromTrack: ["a", "b"] }, current);
    expect(Array.from(merged.hiddenFromTrack)).toEqual(["a", "b"]);
  });

  it("keeps the current state reference when nothing changed", () => {
    const current = { hiddenFromTrack: new Set(["a"]) };
    const merged = mergeHiddenFromTrack({ hiddenFromTrack: ["a"] }, current);
    expect(merged).toBe(current);
  });

  it("falls back to the current state for malformed persisted data", () => {
    const current = { hiddenFromTrack: new Set(["a"]) };
    expect(mergeHiddenFromTrack({ hiddenFromTrack: [1, 2] }, current)).toBe(current);
    expect(mergeHiddenFromTrack("not-an-object", current)).toBe(current);
    expect(mergeHiddenFromTrack(null, current)).toBe(current);
  });
});

describe("resolveHiddenTrackStorage", () => {
  it("falls back to a no-op storage when evaluated web-side with no window", () => {
    // The unit test project runs the web build in Node, so `window` is genuinely absent here —
    // this exercises the exact crash this guard exists to avoid.
    const asyncStorage = {
      getItem: () => {
        throw new Error("must not be called without a window");
      },
      setItem: () => {
        throw new Error("must not be called without a window");
      },
      removeItem: () => {
        throw new Error("must not be called without a window");
      },
    };

    const storage = resolveHiddenTrackStorage(asyncStorage);

    expect(storage.getItem("key")).toBeNull();
    expect(() => storage.setItem("key", "value")).not.toThrow();
    expect(() => storage.removeItem("key")).not.toThrow();
  });
});
