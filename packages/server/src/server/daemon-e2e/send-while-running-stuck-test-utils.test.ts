import { describe, expect, test } from "vitest";

import { applyAgentInputProcessingTransition } from "./send-while-running-stuck-test-utils.js";
import type { AgentSnapshotPayload } from "../messages.js";

function snapshot(status: "running" | "idle", updatedAtMs: number): AgentSnapshotPayload {
  return {
    status,
    updatedAt: new Date(updatedAtMs).toISOString(),
  } as unknown as AgentSnapshotPayload;
}

describe("applyAgentInputProcessingTransition", () => {
  test("clears processing for stale non-running snapshot after reconnect", () => {
    const result = applyAgentInputProcessingTransition({
      snapshot: snapshot("idle", 1_000),
      currentIsProcessing: true,
      previousIsRunning: true,
      latestUpdatedAt: 2_000,
    });

    expect(result).toEqual({
      isProcessing: false,
      previousIsRunning: false,
      latestUpdatedAt: 2_000,
    });
  });

  test("keeps processing for stale running snapshot", () => {
    const result = applyAgentInputProcessingTransition({
      snapshot: snapshot("running", 1_000),
      currentIsProcessing: true,
      previousIsRunning: true,
      latestUpdatedAt: 2_000,
    });

    expect(result).toEqual({
      isProcessing: true,
      previousIsRunning: true,
      latestUpdatedAt: 2_000,
    });
  });

  test("clears processing when fresh update stops running", () => {
    const result = applyAgentInputProcessingTransition({
      snapshot: snapshot("idle", 3_000),
      currentIsProcessing: true,
      previousIsRunning: true,
      latestUpdatedAt: 2_000,
    });

    expect(result).toEqual({
      isProcessing: false,
      previousIsRunning: false,
      latestUpdatedAt: 3_000,
    });
  });
});
