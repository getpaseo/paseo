import { describe, expect, it } from "vitest";
import { keyboardShortcutRoutingAvailable, keyboardShortcutsAvailable } from "./availability";

describe("keyboardShortcutsAvailable", () => {
  it("matches the environments that render shortcut badges", () => {
    expect(keyboardShortcutsAvailable({ isNative: false, isCompact: false })).toBe(true);
    expect(keyboardShortcutsAvailable({ isNative: false, isCompact: true })).toBe(false);
    expect(keyboardShortcutsAvailable({ isNative: true, isCompact: false })).toBe(false);
    expect(keyboardShortcutsAvailable({ isNative: true, isCompact: true })).toBe(false);
  });
});

describe("keyboardShortcutRoutingAvailable", () => {
  it("routes on native, where the key commands arrive without badges", () => {
    expect(keyboardShortcutRoutingAvailable({ isNative: true, isCompact: true })).toBe(true);
    expect(keyboardShortcutRoutingAvailable({ isNative: true, isCompact: false })).toBe(true);
  });

  it("leaves compact web alone, which has no key source wired up", () => {
    expect(keyboardShortcutRoutingAvailable({ isNative: false, isCompact: true })).toBe(false);
    expect(keyboardShortcutRoutingAvailable({ isNative: false, isCompact: false })).toBe(true);
  });
});
