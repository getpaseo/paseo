import { describe, expect, it } from "vitest";
import { desktopKeyboardAvailable, mobilePanelGesturesAvailable } from "./input-behavior";

describe("input behavior independent of desktop window width", () => {
  it.each([false, true])("keeps Electron keyboard behavior with compact=%s", (isCompact) => {
    expect(desktopKeyboardAvailable({ isNative: false, isCompact, isElectron: true })).toBe(true);
  });

  it("preserves keyboard behavior on browser and native clients", () => {
    expect(desktopKeyboardAvailable({ isNative: false, isCompact: false, isElectron: false })).toBe(
      true,
    );
    expect(desktopKeyboardAvailable({ isNative: false, isCompact: true, isElectron: false })).toBe(
      false,
    );
    expect(desktopKeyboardAvailable({ isNative: true, isCompact: false, isElectron: false })).toBe(
      false,
    );
    expect(desktopKeyboardAvailable({ isNative: true, isCompact: true, isElectron: false })).toBe(
      false,
    );
  });

  it("reserves drawer dragging for clients outside Electron", () => {
    expect(mobilePanelGesturesAvailable({ isElectron: true })).toBe(false);
    expect(mobilePanelGesturesAvailable({ isElectron: false })).toBe(true);
  });
});
