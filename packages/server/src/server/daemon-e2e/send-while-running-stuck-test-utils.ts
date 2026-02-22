import type { AgentSnapshotPayload } from "../messages.js";

export function applyAgentInputProcessingTransition(input: {
  snapshot: AgentSnapshotPayload;
  currentIsProcessing: boolean;
  previousIsRunning: boolean;
  latestUpdatedAt: number;
}): { isProcessing: boolean; previousIsRunning: boolean; latestUpdatedAt: number } {
  const updatedAt = new Date(input.snapshot.updatedAt).getTime();
  const isRunning = input.snapshot.status === "running";
  if (updatedAt < input.latestUpdatedAt) {
    // Reconnect flows can deliver an authoritative non-running snapshot
    // whose timestamp predates this client's local "processing started" time.
    // Clear processing to avoid getting stuck even when we miss an edge transition.
    if (input.currentIsProcessing && !isRunning) {
      return {
        isProcessing: false,
        previousIsRunning: false,
        latestUpdatedAt: input.latestUpdatedAt,
      };
    }
    return {
      isProcessing: input.currentIsProcessing,
      previousIsRunning: input.previousIsRunning,
      latestUpdatedAt: input.latestUpdatedAt,
    };
  }

  const wasRunning = input.previousIsRunning;
  let isProcessing = input.currentIsProcessing;

  if (isProcessing) {
    const hasEnteredRunning = !wasRunning && isRunning;
    const hasFreshRunningUpdateWhileRunning =
      wasRunning && isRunning && updatedAt > input.latestUpdatedAt;
    const hasStoppedRunning = wasRunning && !isRunning;

    if (
      hasEnteredRunning ||
      hasFreshRunningUpdateWhileRunning ||
      hasStoppedRunning
    ) {
      isProcessing = false;
    }
  }

  return {
    isProcessing,
    previousIsRunning: isRunning,
    latestUpdatedAt: updatedAt,
  };
}
