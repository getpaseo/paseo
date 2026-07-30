import { describe, expect, test } from "vitest";
import {
  AgentListItemPayloadSchema,
  AgentSnapshotPayloadSchema,
  parseServerInfoStatusPayload,
} from "./messages.js";

function createAgentSnapshot() {
  return {
    id: "agent-summary",
    provider: "codex",
    cwd: "/tmp/project",
    model: "gpt-5.6",
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:01:00.000Z",
    lastUserMessageAt: "2026-07-30T12:00:30.000Z",
    status: "running",
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
    title: "Implement summaries",
    labels: {},
  };
}

describe("agent purpose summary wire compatibility", () => {
  test("accepts purpose summaries on agent snapshots and list items", () => {
    const snapshot = AgentSnapshotPayloadSchema.parse({
      ...createAgentSnapshot(),
      summary: "Adding persisted rolling purpose summaries.",
    });
    const listItem = AgentListItemPayloadSchema.parse({
      id: snapshot.id,
      shortId: snapshot.id.slice(0, 7),
      title: snapshot.title,
      summary: snapshot.summary,
      provider: snapshot.provider,
      model: snapshot.model,
      status: snapshot.status,
      cwd: snapshot.cwd,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      lastUserMessageAt: snapshot.lastUserMessageAt,
      labels: snapshot.labels,
    });

    expect(snapshot.summary).toBe("Adding persisted rolling purpose summaries.");
    expect(listItem.summary).toBe("Adding persisted rolling purpose summaries.");
  });

  test("keeps summary optional for older daemon payloads", () => {
    const snapshot = AgentSnapshotPayloadSchema.parse(createAgentSnapshot());

    expect(snapshot).not.toHaveProperty("summary");
  });

  test("parses the agent purpose summary feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: {
        agentPurposeSummary: true,
      },
    });

    expect(parsed?.features?.agentPurposeSummary).toBe(true);
  });
});
