import { describe, expect, it } from "vitest";
import {
  COMPACT_MAX_AVAILABLE_RATIO,
  COMPACT_MAX_INPUT_LINES,
  COMPOSER_INPUT_LINE_HEIGHT,
  DEFAULT_MAX_INPUT_HEIGHT,
  resolveMaxInputHeight,
} from "./max-height";

const TEN_LINE_CAP = Math.ceil(COMPOSER_INPUT_LINE_HEIGHT * COMPACT_MAX_INPUT_LINES);
const THREE_LINE_FLOOR = Math.ceil(COMPOSER_INPUT_LINE_HEIGHT * 3);

describe("resolveMaxInputHeight", () => {
  it("lets desktop composers grow to half the window, with a 160px floor", () => {
    expect(resolveMaxInputHeight({ windowHeight: 1080, isCompact: false })).toBe(540);
    expect(resolveMaxInputHeight({ windowHeight: 200, isCompact: false })).toBe(
      DEFAULT_MAX_INPUT_HEIGHT,
    );
  });

  it("caps compact composers at 10 lines when the keyboard is closed", () => {
    expect(resolveMaxInputHeight({ windowHeight: 852, isCompact: true })).toBe(TEN_LINE_CAP);
    expect(TEN_LINE_CAP).toBe(210);
  });

  it("caps compact composers to 30% of the remaining window once the keyboard is up", () => {
    const windowHeight = 852;
    const keyboardInset = 336;
    expect(
      resolveMaxInputHeight({
        windowHeight,
        isCompact: true,
        keyboardInset,
      }),
    ).toBe(Math.floor((windowHeight - keyboardInset) * COMPACT_MAX_AVAILABLE_RATIO));
  });

  it("never shrinks below three lines on a short compact window", () => {
    expect(
      resolveMaxInputHeight({
        windowHeight: 100,
        isCompact: true,
        keyboardInset: 80,
      }),
    ).toBe(THREE_LINE_FLOOR);
  });

  it("falls back to the default cap for invalid window sizes", () => {
    expect(resolveMaxInputHeight({ windowHeight: 0, isCompact: true })).toBe(
      DEFAULT_MAX_INPUT_HEIGHT,
    );
    expect(resolveMaxInputHeight({ windowHeight: Number.NaN, isCompact: false })).toBe(
      DEFAULT_MAX_INPUT_HEIGHT,
    );
  });
});
