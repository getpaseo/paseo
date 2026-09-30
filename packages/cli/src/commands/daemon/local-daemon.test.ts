import { expect, test } from "vitest";

import { parseDurationMs } from "./local-daemon.js";

test("parseDurationMs accepts suffixed and bare-second durations", () => {
  expect(parseDurationMs("30s", 0)).toBe(30_000);
  expect(parseDurationMs("10m", 0)).toBe(600_000);
  expect(parseDurationMs("2h", 0)).toBe(7_200_000);
  expect(parseDurationMs("1500ms", 0)).toBe(1_500);
  expect(parseDurationMs("45", 0)).toBe(45_000);
  expect(parseDurationMs("1.5m", 0)).toBe(90_000);
});

test("parseDurationMs uses the fallback when omitted", () => {
  expect(parseDurationMs(undefined, 42)).toBe(42);
  expect(parseDurationMs("", 42)).toBe(42);
});

test("parseDurationMs rejects malformed durations", () => {
  expect(() => parseDurationMs("soon", 0)).toThrow();
  expect(() => parseDurationMs("-5m", 0)).toThrow();
});
