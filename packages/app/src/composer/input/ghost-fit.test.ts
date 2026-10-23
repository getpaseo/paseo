import { describe, expect, it } from "vitest";
import { estimateGhostWidthPx, ghostFitsOnOneLine, shouldShowFocusHint } from "./ghost-fit";

const FONT_SIZE = 15;

describe("ghostFitsOnOneLine", () => {
  it("accepts a short suggestion in a wide composer", () => {
    expect(
      ghostFitsOnOneLine({
        text: "run the failing test",
        rowWidth: 700,
        fontSize: FONT_SIZE,
        hintVisible: true,
      }),
    ).toBe(true);
  });

  it("rejects a suggestion the composer would ellipsise", () => {
    expect(
      ghostFitsOnOneLine({
        text: "x".repeat(160),
        rowWidth: 400,
        fontSize: FONT_SIZE,
        hintVisible: true,
      }),
    ).toBe(false);
  });

  it("rejects everything until the row has been measured", () => {
    expect(
      ghostFitsOnOneLine({ text: "ok", rowWidth: null, fontSize: FONT_SIZE, hintVisible: false }),
    ).toBe(false);
    expect(
      ghostFitsOnOneLine({ text: "ok", rowWidth: 0, fontSize: FONT_SIZE, hintVisible: false }),
    ).toBe(false);
  });

  // A Latin-averaged estimate puts this at 242px and calls it a fit, so Enter
  // would have sent text the composer had ellipsised.
  it("counts a CJK code point as a full em, not as a Latin average", () => {
    const text = "把失败的认证测试重新跑一遍，并把完整的结果贴到这里来";

    expect(estimateGhostWidthPx(text, FONT_SIZE)).toBeGreaterThan(text.length * FONT_SIZE * 0.9);
    expect(
      ghostFitsOnOneLine({ text, rowWidth: 360, fontSize: FONT_SIZE, hintVisible: false }),
    ).toBe(false);
    expect(
      ghostFitsOnOneLine({ text, rowWidth: 700, fontSize: FONT_SIZE, hintVisible: false }),
    ).toBe(true);
  });

  it("leaves room for the Tab hint when it is shown", () => {
    const text = "y".repeat(42);
    const rowWidth = text.length * FONT_SIZE * 0.62 + 14;

    expect(ghostFitsOnOneLine({ text, rowWidth, fontSize: FONT_SIZE, hintVisible: false })).toBe(
      true,
    );
    expect(ghostFitsOnOneLine({ text, rowWidth, fontSize: FONT_SIZE, hintVisible: true })).toBe(
      false,
    );
  });
});

describe("shouldShowFocusHint", () => {
  const base = { isWeb: true, isInputFocused: false, hasValue: false, hasGhost: false };

  // Both are drawn at the end of the input row; at phone width they collided.
  it("yields the row to a ghost suggestion", () => {
    expect(shouldShowFocusHint(base)).toBe(true);
    expect(shouldShowFocusHint({ ...base, hasGhost: true })).toBe(false);
  });

  it("stays hidden when focused, typed into, or off the web", () => {
    expect(shouldShowFocusHint({ ...base, isInputFocused: true })).toBe(false);
    expect(shouldShowFocusHint({ ...base, hasValue: true })).toBe(false);
    expect(shouldShowFocusHint({ ...base, isWeb: false })).toBe(false);
  });
});
