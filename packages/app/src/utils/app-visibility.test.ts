import { expect, test } from "vitest";
import { isAppActivelyVisible, isAppVisible } from "./app-visibility";

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
