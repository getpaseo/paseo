import { describe, expect, it } from "vitest";
import { reduceNativeComposerHeight } from "./height-state";

const bounds = { minHeight: 30, maxHeight: 240 };

describe("native composer height", () => {
  it("grows a fresh composer from the content size exposed during caret scrolling", () => {
    expect(
      reduceNativeComposerHeight(30, bounds, {
        type: "content-measured",
        height: 131,
      }),
    ).toBe(131);
  });

  it("remeasures a restored multiline draft before applying its intrinsic height", () => {
    const invalidatedHeight = reduceNativeComposerHeight(30, bounds, { type: "remeasure" });

    expect(invalidatedHeight).toBeGreaterThan(30);
    expect(
      reduceNativeComposerHeight(invalidatedHeight, bounds, {
        type: "content-measured",
        height: 173,
      }),
    ).toBe(173);
  });

  it("shrinks a grown composer after deletion and the resulting native measurement", () => {
    const invalidatedHeight = reduceNativeComposerHeight(240, bounds, {
      type: "text-changed",
      previousText: "one\ntwo\nthree",
      nextText: "one",
    });

    expect(invalidatedHeight).toBeLessThan(240);
    expect(
      reduceNativeComposerHeight(invalidatedHeight, bounds, {
        type: "content-measured",
        height: 50,
      }),
    ).toBe(50);
  });

  it("does not disturb height while text grows", () => {
    expect(
      reduceNativeComposerHeight(120, bounds, {
        type: "text-changed",
        previousText: "one",
        nextText: "one two",
      }),
    ).toBe(120);
  });

  it("clamps measurements and resets to the current bounds", () => {
    expect(
      reduceNativeComposerHeight(30, bounds, {
        type: "content-measured",
        height: 999,
      }),
    ).toBe(240);
    expect(reduceNativeComposerHeight(180, bounds, { type: "reset" })).toBe(30);
  });
});
