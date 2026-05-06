import { describe, expect, it } from "vitest";
import { isImeComposingKeyboardEvent } from "./keyboard-ime";

describe("isImeComposingKeyboardEvent", () => {
  it("ignores events while IME composition is active", () => {
    expect(
      isImeComposingKeyboardEvent({
        isComposing: true,
        keyCode: 13,
      } as KeyboardEvent),
    ).toBe(true);
  });

  it("ignores Chromium IME fallback events with keyCode 229", () => {
    expect(
      isImeComposingKeyboardEvent({
        isComposing: false,
        keyCode: 229,
      } as KeyboardEvent),
    ).toBe(true);
  });

  it("keeps regular keyboard events eligible for shortcuts", () => {
    expect(
      isImeComposingKeyboardEvent({
        isComposing: false,
        keyCode: 13,
      } as KeyboardEvent),
    ).toBe(false);
  });
});
