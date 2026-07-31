import { describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema } from "./messages.js";

const baseSnapshot = {
  id: "agent-1",
  provider: "opencode",
  cwd: "/tmp/work",
  model: null,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "running" as const,
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
  title: null,
  labels: {},
};

describe("material progress wire compatibility", () => {
  it("accepts legacy snapshots without the optional signal", () => {
    expect(AgentSnapshotPayloadSchema.parse(baseSnapshot).materialProgress).toBeUndefined();
  });

  it("accepts a structured material progress signal", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      ...baseSnapshot,
      materialProgress: {
        state: "warning",
        completedCompactionsSinceMaterialProgress: 1,
        lastMaterialProgressAt: null,
        lastMaterialProgressKind: null,
        reason: "One compaction completed without later material progress.",
      },
    });

    expect(parsed.materialProgress?.state).toBe("warning");
  });
});
