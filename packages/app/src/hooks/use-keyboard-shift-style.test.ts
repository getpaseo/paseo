import { describe, expect, it } from "vitest";
import {
  resolveFloatingComposerBottom,
  resolveKeyboardShift,
  resolveWebAbsoluteDeviceFixedOffset,
  resolveWebComposerDockFillDepth,
} from "./keyboard-shift-policy";

describe("resolveWebAbsoluteDeviceFixedOffset", () => {
  it("does not add movement when Safari's page pan already reaches the layout bottom", () => {
    expect(
      resolveWebAbsoluteDeviceFixedOffset({
        layoutViewportHeight: 844,
        visualViewportHeight: 500,
        visualViewportPageTop: 344,
      }),
    ).toBe(0);
  });

  it("adds only the remaining movement after a partial page pan", () => {
    expect(
      resolveWebAbsoluteDeviceFixedOffset({
        layoutViewportHeight: 844,
        visualViewportHeight: 500,
        visualViewportPageTop: 214,
      }),
    ).toBe(-130);
  });

  it("compensates when Safari has already shrunk the layout root", () => {
    expect(
      resolveWebAbsoluteDeviceFixedOffset({
        layoutViewportHeight: 500,
        visualViewportHeight: 500,
        visualViewportPageTop: 214,
      }),
    ).toBe(214);
  });

  it("returns zero for a closed viewport and invalid measurements", () => {
    expect(
      resolveWebAbsoluteDeviceFixedOffset({
        layoutViewportHeight: 844,
        visualViewportHeight: 844,
        visualViewportPageTop: 0,
      }),
    ).toBe(0);
    expect(
      resolveWebAbsoluteDeviceFixedOffset({
        layoutViewportHeight: Number.NaN,
        visualViewportHeight: 500,
        visualViewportPageTop: 214,
      }),
    ).toBe(0);
  });
});

describe("resolveWebComposerDockFillDepth", () => {
  it("fills the portion hidden below the visual viewport", () => {
    expect(
      resolveWebComposerDockFillDepth({
        layoutViewportHeight: 844,
        visualViewportHeight: 500,
      }),
    ).toBe(344);
  });

  it("does not extend for closed or invalid viewports", () => {
    expect(
      resolveWebComposerDockFillDepth({
        layoutViewportHeight: 844,
        visualViewportHeight: 844,
      }),
    ).toBe(0);
    expect(
      resolveWebComposerDockFillDepth({
        layoutViewportHeight: Number.NaN,
        visualViewportHeight: 500,
      }),
    ).toBe(0);
  });
});

describe("resolveFloatingComposerBottom", () => {
  it("keeps compact web bottom fixed when keyboard values change", () => {
    expect(
      resolveFloatingComposerBottom({
        isWeb: true,
        isCompact: true,
        keyboardShift: 0,
        bottomInset: 34,
      }),
    ).toBe(-34);
    expect(
      resolveFloatingComposerBottom({
        isWeb: true,
        isCompact: true,
        keyboardShift: 300,
        bottomInset: 34,
      }),
    ).toBe(-34);
  });

  it("preserves the compact native safe-area policy", () => {
    expect(
      resolveFloatingComposerBottom({
        isWeb: false,
        isCompact: true,
        keyboardShift: 0,
        bottomInset: 34,
      }),
    ).toBe(-34);
    expect(
      resolveFloatingComposerBottom({
        isWeb: false,
        isCompact: true,
        keyboardShift: 296,
        bottomInset: 34,
      }),
    ).toBe(0);
  });

  it("does not move non-compact composers", () => {
    expect(
      resolveFloatingComposerBottom({
        isWeb: true,
        isCompact: false,
        keyboardShift: 84,
        bottomInset: 34,
      }),
    ).toBe(0);
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
