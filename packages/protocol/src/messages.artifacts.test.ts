import { describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema } from "./messages.js";

describe("agent artifact snapshots", () => {
  it("accepts additive per-agent artifacts", () => {
    const snapshot = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      model: null,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:01:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Artifacts",
      labels: {},
      artifacts: [
        {
          path: "report.html",
          name: "report.html",
          kind: "html",
          mimeType: "text/html",
          size: 42,
          createdAt: "2026-07-22T00:00:30.000Z",
          updatedAt: "2026-07-22T00:00:30.000Z",
        },
      ],
    });

    expect(snapshot.artifacts?.[0]?.path).toBe("report.html");
    expect(snapshot.companionEntries).toBeUndefined();
    const upgraded = {
      ...snapshot,
      companionEntries: [
        {
          id: "turn:one",
          kind: "outcome",
          status: "completed",
          text: "Report is ready",
          timestamp: "2026-09-21T12:00:00.000Z",
          truncated: false,
        },
      ],
    };
    expect(AgentSnapshotPayloadSchema.parse(upgraded).companionEntries).toEqual(
      upgraded.companionEntries,
    );
    // The previous wire shape ignores the additive field and still parses the snapshot.
    expect(AgentSnapshotPayloadSchema.omit({ companionEntries: true }).parse(upgraded)).toEqual(
      snapshot,
    );
  });
});
