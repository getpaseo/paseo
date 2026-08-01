import { describe, expect, it } from "vitest";
import { shouldSubscribeToBackgroundTaskOutput } from "./use-background-task-output";

describe("background task output focus gate", () => {
  it("subscribes only when tab is focused and feature supported", () => {
    expect(shouldSubscribeToBackgroundTaskOutput({ supported: true, isPaneFocused: true })).toBe(
      true,
    );
    expect(shouldSubscribeToBackgroundTaskOutput({ supported: true, isPaneFocused: false })).toBe(
      false,
    );
    expect(shouldSubscribeToBackgroundTaskOutput({ supported: false, isPaneFocused: true })).toBe(
      false,
    );
  });
});
