import { describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema, ServerInfoStatusPayloadSchema } from "./messages.js";

const baseSnapshot = {
  id: "agent-1",
  provider: "opencode",
  cwd: "/tmp/work",
  model: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
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

  it("accepts an epoch-bound material progress snapshot", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      ...baseSnapshot,
      materialProgress: {
        state: "warning",
        timelineEpoch: "epoch-2",
        continuationBoundarySeq: 42,
        observedThroughSeq: 57,
        completedCompactionsSinceMaterialProgress: 1,
        lastMaterialProgressAt: "2026-08-01T00:00:01.000Z",
        lastMaterialProgressKind: "evidence",
        reason: "One compaction completed without later material progress.",
      },
    });

    expect(parsed.materialProgress).toMatchObject({
      state: "warning",
      timelineEpoch: "epoch-2",
      continuationBoundarySeq: 42,
      observedThroughSeq: 57,
      lastMaterialProgressKind: "evidence",
    });
  });

  it("advertises the material-progress feature independently of legacy snapshots", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { materialProgress: true },
      }).features?.materialProgress,
    ).toBe(true);
  });
});
