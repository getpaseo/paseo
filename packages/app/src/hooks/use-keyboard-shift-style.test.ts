import { describe, expect, it } from "vitest";
import {
  resolveStreamKeyboardInset,
  shouldReconcileHiddenKeyboardEnd,
  resolveKeyboardShift,
  reserveKeyboardLayoutShift,
  shouldUseCompactExplorerKeyboardPadding,
} from "./keyboard-shift-policy";

describe("keyboard layout reservation", () => {
  it("reserves the opening destination before motion and releases it only after closing", () => {
    const opened = reserveKeyboardLayoutShift({ current: 0, target: 308, phase: "start" });
    expect(opened).toBe(308);
    const closing = reserveKeyboardLayoutShift({ current: opened, target: 0, phase: "start" });
    expect(closing).toBe(308);
    expect(reserveKeyboardLayoutShift({ current: closing, target: 0, phase: "end" })).toBe(0);
  });

  it("keeps enough space when a resize or reversal interrupts keyboard motion", () => {
    const resizing = reserveKeyboardLayoutShift({ current: 308, target: 250, phase: "start" });
    expect(resizing).toBe(308);
    const reversing = reserveKeyboardLayoutShift({
      current: resizing,
      target: 340,
      phase: "start",
    });
    expect(reversing).toBe(340);
    expect(reserveKeyboardLayoutShift({ current: reversing, target: 340, phase: "end" })).toBe(340);
  });
});

describe("resolveStreamKeyboardInset", () => {
  it("uses the native scroll inset on iOS without changing content size", () => {
    expect(resolveStreamKeyboardInset({ platform: "ios", settledShift: 311 })).toEqual({
      contentContainerPaddingBottom: 0,
      contentInset: { bottom: 311 },
    });
  });

  it("keeps Android's exact content-container padding behavior", () => {
    expect(resolveStreamKeyboardInset({ platform: "android", settledShift: 311 })).toEqual({
      contentContainerPaddingBottom: 311,
      contentInset: undefined,
    });
  });

  it("does not expose a negative inset", () => {
    expect(resolveStreamKeyboardInset({ platform: "ios", settledShift: -1 })).toEqual({
      contentContainerPaddingBottom: 0,
      contentInset: { bottom: 0 },
    });
  });
});

describe("resolveKeyboardShift", () => {
  it("keeps the existing open-keyboard offset behavior", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 320,
        keyboardProgress: 1,
        bottomInset: 24,
        isIos: false,
        iosMinHeight: 120,
      }),
    ).toBe(296);
  });

  it("treats progress zero as closed even when Android reports a stale height", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 320,
        keyboardProgress: 0,
        bottomInset: 24,
        isIos: false,
        iosMinHeight: 120,
      }),
    ).toBe(0);
  });

  it("still ignores small iOS accessory bar reports", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 80,
        keyboardProgress: 1,
        bottomInset: 0,
        isIos: true,
        iosMinHeight: 120,
      }),
    ).toBe(0);
  });
});

describe("shouldReconcileHiddenKeyboardEnd", () => {
  it("closes stale iOS keyboard state without letting a late visible end resurrect it", () => {
    expect(
      shouldReconcileHiddenKeyboardEnd({
        height: 0,
        progress: 0,
      }),
    ).toBe(true);
    expect(
      shouldReconcileHiddenKeyboardEnd({
        height: 320,
        progress: 1,
      }),
    ).toBe(false);
  });
});

describe("shouldUseCompactExplorerKeyboardPadding", () => {
  it("keeps the changes viewport stable while preserving padding for other tabs", () => {
    expect(shouldUseCompactExplorerKeyboardPadding({ isGit: true, explorerTab: "changes" })).toBe(
      false,
    );
    expect(shouldUseCompactExplorerKeyboardPadding({ isGit: true, explorerTab: "files" })).toBe(
      true,
    );
    expect(shouldUseCompactExplorerKeyboardPadding({ isGit: false, explorerTab: "changes" })).toBe(
      true,
    );
  });
});
