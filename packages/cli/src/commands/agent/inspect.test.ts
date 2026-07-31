import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { toInspectData, toInspectRows } from "./inspect.js";

describe("agent inspect material progress", () => {
  it("preserves the structured signal and renders its state and reason", () => {
    const snapshot = {
      id: "agent-1",
      provider: "opencode",
      cwd: "/tmp/work",
      model: "test-model",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:01:00.000Z",
      lastUserMessageAt: "2026-07-31T00:00:30.000Z",
      status: "running",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Stalled worker",
      labels: {},
      materialProgress: {
        state: "stalled",
        completedCompactionsSinceMaterialProgress: 2,
        lastMaterialProgressAt: null,
        lastMaterialProgressKind: null,
        reason: "Two compactions completed without later material progress.",
      },
    } as AgentSnapshotPayload;

    const inspect = toInspectData(snapshot);
    expect(inspect.MaterialProgress).toEqual(snapshot.materialProgress);
    expect(toInspectRows(inspect)).toContainEqual({
      key: "MaterialProgress",
      value: "stalled: Two compactions completed without later material progress.",
    });
  });
});
