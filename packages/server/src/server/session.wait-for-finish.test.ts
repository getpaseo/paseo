import { describe, expect, test } from "vitest";

import { resolveWaitForFinishError } from "./session.js";
import type { AgentSnapshotPayload } from "./messages.js";

describe("resolveWaitForFinishError", () => {
  test("returns the agent error when the wait result is an error", () => {
    expect(
      resolveWaitForFinishError({
        status: "error",
        final: { lastError: "invalid_json_schema" } as unknown as AgentSnapshotPayload,
      }),
    ).toBe("invalid_json_schema");
  });

  test("returns a generic fallback when the agent ended in error without a message", () => {
    expect(
      resolveWaitForFinishError({
        status: "error",
        final: {} as unknown as AgentSnapshotPayload,
      }),
    ).toBe("Agent failed");
  });

  test("returns null for non-error wait results", () => {
    expect(
      resolveWaitForFinishError({
        status: "idle",
        final: { lastError: "should not surface" } as unknown as AgentSnapshotPayload,
      }),
    ).toBeNull();
  });
});
