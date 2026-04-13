import { describe, expect, test } from "vitest";

import { resolveWaitForFinishError } from "./session.js";

describe("resolveWaitForFinishError", () => {
  test("returns the agent error when the wait result is an error", () => {
    expect(
      resolveWaitForFinishError({
        status: "error",
        final: { lastError: "invalid_json_schema" } as any,
      }),
    ).toBe("invalid_json_schema");
  });

  test("returns a generic fallback when the agent ended in error without a message", () => {
    expect(
      resolveWaitForFinishError({
        status: "error",
        final: {} as any,
      }),
    ).toBe("Agent failed");
  });

  test("returns null for non-error wait results", () => {
    expect(
      resolveWaitForFinishError({
        status: "idle",
        final: { lastError: "should not surface" } as any,
      }),
    ).toBeNull();
  });
});
