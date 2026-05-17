import { describe, expect, it } from "vitest";
import {
  hasPendingTerminalModifiers,
  isAppleHandheldPlatform,
  isTerminalModifierDomKey,
  mapTerminalDataToKey,
  mergeTerminalModifiers,
  normalizeDomTerminalKey,
  normalizeTerminalTransportKey,
  resolvePendingModifierDataInput,
  shouldInterceptDomTerminalKey,
} from "./terminal-keys";

const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

describe("terminal key helpers", () => {
  it("normalizes supported DOM keys", () => {
    expect(normalizeDomTerminalKey("Esc")).toBe("Escape");
    expect(normalizeDomTerminalKey(" ")).toBe(" ");
    expect(normalizeDomTerminalKey("ArrowUp")).toBe("ArrowUp");
    expect(normalizeDomTerminalKey("F12")).toBe("F12");
  });

  it("filters unsupported and composing DOM keys", () => {
    expect(normalizeDomTerminalKey("Dead")).toBeNull();
    expect(normalizeDomTerminalKey("Unidentified")).toBeNull();
    expect(normalizeDomTerminalKey("MediaPlayPause")).toBeNull();
  });

  it("detects modifier DOM keys", () => {
    expect(isTerminalModifierDomKey("Control")).toBe(true);
    expect(isTerminalModifierDomKey("Shift")).toBe(true);
    expect(isTerminalModifierDomKey("a")).toBe(false);
  });

  it("lowercases printable transport keys", () => {
    expect(normalizeTerminalTransportKey("C")).toBe("c");
    expect(normalizeTerminalTransportKey("Escape")).toBe("Escape");
  });

  it("merges pending modifiers with native key modifiers", () => {
    expect(
      mergeTerminalModifiers({
        pendingModifiers: { ctrl: true, shift: false, alt: true },
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      }),
    ).toEqual({
      ctrl: true,
      shift: true,
      alt: true,
      meta: false,
    });
  });

  it("only intercepts when pending modifiers are active", () => {
    expect(
      shouldInterceptDomTerminalKey({
        key: "Escape",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
      }),
    ).toBe(false);
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
      }),
    ).toBe(false);
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: true, shift: false, alt: false },
      }),
    ).toBe(true);
    expect(
      shouldInterceptDomTerminalKey({
        key: "Escape",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: true },
      }),
    ).toBe(true);
  });

  it("does not intercept modified Enter before enhanced input mode is active", () => {
    expect(
      shouldInterceptDomTerminalKey({
        key: "Enter",
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
      }),
    ).toBe(false);
  });

  it("intercepts Enter with any DOM modifier after enhanced input mode is active", () => {
    expect(
      shouldInterceptDomTerminalKey({
        key: "Enter",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        enhancedInputActive: true,
      }),
    ).toBe(true);
    expect(
      shouldInterceptDomTerminalKey({
        key: "Enter",
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        enhancedInputActive: true,
      }),
    ).toBe(true);
    expect(
      shouldInterceptDomTerminalKey({
        key: "Enter",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: true,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        enhancedInputActive: true,
      }),
    ).toBe(true);
  });

  it("does not intercept plain Enter without modifiers", () => {
    expect(
      shouldInterceptDomTerminalKey({
        key: "Enter",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
      }),
    ).toBe(false);
  });

  it("intercepts plain Ctrl+C on iPad so xterm's keyCode-13 quirk never reaches the PTY (#1049)", () => {
    // See COMPAT(xterm-ipad-ctrl-c) in terminal-keys.ts.
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        isAppleHandheld: true,
      }),
    ).toBe(true);
    // Uppercase variant in case Caps Lock is on.
    expect(
      shouldInterceptDomTerminalKey({
        key: "C",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        isAppleHandheld: true,
      }),
    ).toBe(true);
  });

  it("does not intercept other Ctrl+letter combos on iPad (xterm handles them correctly)", () => {
    for (const key of ["b", "d", "z", "a", "r", "l"]) {
      expect(
        shouldInterceptDomTerminalKey({
          key,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          pendingModifiers: { ctrl: false, shift: false, alt: false },
          isAppleHandheld: true,
        }),
      ).toBe(false);
    }
  });

  it("does not intercept Ctrl+C on real macOS / Windows / Linux", () => {
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        isAppleHandheld: false,
      }),
    ).toBe(false);
  });

  it("does not intercept Cmd+C on iPad (Cmd-based shortcuts stay with the OS)", () => {
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: true,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        isAppleHandheld: true,
      }),
    ).toBe(false);
  });

  it("does not intercept Ctrl+Shift+C / Ctrl+Alt+C on iPad", () => {
    // Only bare Ctrl+C is affected by the WebKit quirk; modified variants stay with xterm.
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        isAppleHandheld: true,
      }),
    ).toBe(false);
    expect(
      shouldInterceptDomTerminalKey({
        key: "c",
        ctrlKey: true,
        shiftKey: false,
        altKey: true,
        metaKey: false,
        pendingModifiers: { ctrl: false, shift: false, alt: false },
        isAppleHandheld: true,
      }),
    ).toBe(false);
  });

  it("detects iPad masquerading as macOS via maxTouchPoints", () => {
    expect(
      isAppleHandheldPlatform({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 }),
    ).toBe(true);
  });

  it("detects iPhone/iPod by UA", () => {
    expect(
      isAppleHandheldPlatform({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 }),
    ).toBe(true);
  });

  it("does not flag real macOS desktop as a handheld", () => {
    expect(
      isAppleHandheldPlatform({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 0 }),
    ).toBe(false);
  });

  it("does not flag macOS when maxTouchPoints == 1 (some trackpad contexts)", () => {
    expect(
      isAppleHandheldPlatform({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 1 }),
    ).toBe(false);
  });

  it("tolerates null/undefined navigator-style inputs", () => {
    expect(isAppleHandheldPlatform({ userAgent: null, platform: null, maxTouchPoints: null })).toBe(
      false,
    );
    expect(
      isAppleHandheldPlatform({
        userAgent: undefined,
        platform: undefined,
        maxTouchPoints: undefined,
      }),
    ).toBe(false);
  });

  it("detects pending modifier state", () => {
    expect(hasPendingTerminalModifiers({ ctrl: false, shift: false, alt: false })).toBe(false);
    expect(hasPendingTerminalModifiers({ ctrl: true, shift: false, alt: false })).toBe(true);
  });

  it("maps onData bytes to terminal keys for modifier fallback", () => {
    expect(mapTerminalDataToKey("c")).toBe("c");
    expect(mapTerminalDataToKey("\r")).toBe("Enter");
    expect(mapTerminalDataToKey("\t")).toBe("Tab");
    expect(mapTerminalDataToKey("\x7f")).toBe("Backspace");
    expect(mapTerminalDataToKey("\x1b")).toBe("Escape");
    expect(mapTerminalDataToKey("\x03")).toBeNull();
    expect(mapTerminalDataToKey("")).toBeNull();
  });

  it("clears pending modifiers when fallback input cannot map to a key", () => {
    expect(
      resolvePendingModifierDataInput({
        data: "hello",
        pendingModifiers: { ctrl: true, shift: false, alt: false },
      }),
    ).toEqual({
      mode: "raw",
      clearPendingModifiers: true,
    });
  });

  it("maps pending modifier fallback to key transport when possible", () => {
    expect(
      resolvePendingModifierDataInput({
        data: "c",
        pendingModifiers: { ctrl: true, shift: false, alt: false },
      }),
    ).toEqual({
      mode: "key",
      key: "c",
      clearPendingModifiers: true,
    });
  });

  it("keeps raw mode unchanged when no pending modifiers exist", () => {
    expect(
      resolvePendingModifierDataInput({
        data: "c",
        pendingModifiers: { ctrl: false, shift: false, alt: false },
      }),
    ).toEqual({
      mode: "raw",
      clearPendingModifiers: false,
    });
  });
});
