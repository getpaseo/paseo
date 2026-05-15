import { describe, expect, test } from "vitest";

import { normalizeProviderReplayTimestamp } from "./provider-history-timestamps.js";

describe("normalizeProviderReplayTimestamp", () => {
  test("preserves valid string timestamps after trimming", () => {
    expect(normalizeProviderReplayTimestamp(" 2026-05-01T10:00:00.000Z ")).toBe(
      "2026-05-01T10:00:00.000Z",
    );
  });

  test("converts numeric second and millisecond timestamps to ISO", () => {
    expect(normalizeProviderReplayTimestamp(1_778_762_475)).toBe("2026-05-14T12:41:15.000Z");
    expect(normalizeProviderReplayTimestamp(1_778_762_475_873)).toBe("2026-05-14T12:41:15.873Z");
  });

  test("returns null for missing or invalid timestamps", () => {
    expect(normalizeProviderReplayTimestamp(undefined)).toBeNull();
    expect(normalizeProviderReplayTimestamp("not a timestamp")).toBeNull();
    expect(normalizeProviderReplayTimestamp(Number.NaN)).toBeNull();
    expect(normalizeProviderReplayTimestamp(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
