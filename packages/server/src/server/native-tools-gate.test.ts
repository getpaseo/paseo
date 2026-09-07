import { expect, test } from "vitest";

import { isNativePaseoToolsEnabled } from "./native-tools-gate.js";

test("mcp enabled + injection off keeps the native catalog available", () => {
  expect(isNativePaseoToolsEnabled(true)).toBe(true);
});

test("absent mcp.enabled defaults to enabled", () => {
  expect(isNativePaseoToolsEnabled(undefined)).toBe(true);
});

test("mcp disabled disables the native catalog regardless of injection", () => {
  expect(isNativePaseoToolsEnabled(false)).toBe(false);
});
