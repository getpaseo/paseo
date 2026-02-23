import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import { deriveOptimisticLifecycleStatus } from "./session-stream-lifecycle";

const turnCompletedEvent: AgentStreamEventPayload = {
  type: "turn_completed",
  provider: "claude",
};

const turnFailedEvent: AgentStreamEventPayload = {
  type: "turn_failed",
  provider: "claude",
  error: "failed",
};

describe("session stream lifecycle helpers", () => {
  it("derives optimistic terminal lifecycle only when current status is running", () => {
    expect(deriveOptimisticLifecycleStatus("running", turnCompletedEvent)).toBe(
      "idle"
    );
    expect(deriveOptimisticLifecycleStatus("running", turnFailedEvent)).toBe(
      "error"
    );
    expect(deriveOptimisticLifecycleStatus("initializing", turnCompletedEvent)).toBe(
      null
    );
    expect(deriveOptimisticLifecycleStatus("idle", turnFailedEvent)).toBe(null);
  });
});
