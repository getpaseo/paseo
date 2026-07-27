import { expect, test } from "vitest";
import { isAppActivelyVisible, isAppVisible, isGuestContentFocused } from "./app-visibility";

test("a visible desktop app remains visible when another window has focus", () => {
  const input = {
    appState: "active",
    native: false,
    documentVisible: true,
    windowFocused: false,
  };

  expect(isAppVisible(input)).toBe(true);
  expect(isAppActivelyVisible(input)).toBe(false);
});

test("a hidden desktop page is neither visible nor actively visible", () => {
  const input = {
    appState: "active",
    native: false,
    documentVisible: false,
    windowFocused: true,
  };

  expect(isAppVisible(input)).toBe(false);
  expect(isAppActivelyVisible(input)).toBe(false);
});

test("guest webview/iframe focus counts as in-app window focus", () => {
  expect(isGuestContentFocused({ tagName: "WEBVIEW" })).toBe(true);
  expect(isGuestContentFocused({ tagName: "webview" })).toBe(true);
  expect(isGuestContentFocused({ tagName: "IFRAME" })).toBe(true);
  expect(isGuestContentFocused({ tagName: "DIV" })).toBe(false);
  expect(isGuestContentFocused(null)).toBe(false);
});

test("visible + guest-focused (via windowFocused) is actively visible — no intrusive yank", () => {
  // Planner input: Code Server focused → treat as actively visible so intrusive
  // mode uses banner only, not navigate.
  expect(
    isAppActivelyVisible({
      appState: "active",
      native: false,
      documentVisible: true,
      windowFocused: true, // getWindowFocused maps guest WEBVIEW → true
    }),
  ).toBe(true);
});
