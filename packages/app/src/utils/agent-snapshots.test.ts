import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { isControlActive, readSelectOption } from "@/agent-controls/option-controls";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "./agent-snapshots";

const BASE_SNAPSHOT: AgentSnapshotPayload = {
  id: "agent-1",
  provider: "codex",
  cwd: "/repo",
  model: null,
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:01:00.000Z",
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
  title: null,
  labels: {},
};

function createSnapshot(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    labels?: Record<string, unknown>;
  } = {},
): AgentSnapshotPayload {
  return {
    ...BASE_SNAPSHOT,
    ...input,
    labels: (input.labels ?? BASE_SNAPSHOT.labels) as AgentSnapshotPayload["labels"],
  };
}

describe("normalizeAgentSnapshot", () => {
  it("keeps a closed agent's stored options and controls, so its Fast control draws", () => {
    const speed = {
      type: "select" as const,
      key: "service_tier",
      label: "Speed",
      defaultValue: "default",
      choices: [
        { value: "default", label: "Normal" },
        { value: "priority", label: "Fast" },
      ],
    };
    const agent = normalizeAgentSnapshot(
      createSnapshot({
        status: "closed",
        controls: [speed],
        options: { service_tier: "priority", sandbox_mode: "read-only" },
      }),
      "server-1",
    );

    expect(agent.status).toBe("closed");
    expect(agent.controls).toEqual([speed]);
    expect(agent.options).toEqual({ service_tier: "priority", sandbox_mode: "read-only" });
    expect(readSelectOption(speed, agent.options ?? {})).toBe("priority");
    expect(isControlActive(speed, agent.options ?? {})).toBe(true);
  });

  it("round-trips identified active turns through the canonical snapshot boundary", () => {
    const snapshot = createSnapshot({
      status: "running",
      activeTurn: { turnId: "turn-1", startedAt: "2026-07-31T12:00:00.000Z" },
    });

    expect(projectAgentSnapshot(normalizeAgentSnapshot(snapshot, "server-1"))).toMatchObject({
      status: "running",
      activeTurn: snapshot.activeTurn,
    });
  });

  it("round-trips session metrics through the canonical snapshot boundary", () => {
    const sessionMetrics = [{ label: "Cost", value: "$0.42", tone: "warning" as const }];

    const agent = normalizeAgentSnapshot(createSnapshot({ sessionMetrics }), "server-1");

    expect(agent.sessionMetrics).toEqual(sessionMetrics);
    expect(projectAgentSnapshot(agent).sessionMetrics).toEqual(sessionMetrics);
  });

  it("round-trips promptSuggestion through the canonical snapshot boundary", () => {
    const agent = normalizeAgentSnapshot(
      createSnapshot({ promptSuggestion: "Run the unit tests" }),
      "server-1",
    );

    expect(agent.promptSuggestion).toBe("Run the unit tests");
    expect(projectAgentSnapshot(agent).promptSuggestion).toBe("Run the unit tests");

    const cleared = normalizeAgentSnapshot(createSnapshot({ promptSuggestion: null }), "server-1");
    expect(cleared.promptSuggestion).toBeNull();
    expect(projectAgentSnapshot(cleared).promptSuggestion).toBeNull();
  });

  it("normalizes identified and legacy active turns at the snapshot boundary", () => {
    const startedAt = "2026-07-31T12:00:00.000Z";
    expect(
      normalizeAgentSnapshot(
        createSnapshot({
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt },
        }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });

    expect(
      normalizeAgentSnapshot(
        createSnapshot({ status: "running", lastUserMessageAt: startedAt }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: null,
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });
  });

  it("derives parentAgentId from the parent label while preserving labels", () => {
    const labels = {
      [PARENT_AGENT_ID_LABEL]: "parent-1",
      "custom.label": "still-here",
    };

    const agent = normalizeAgentSnapshot(createSnapshot({ labels }), "server-1");

    expect(agent.parentAgentId).toBe("parent-1");
    expect(agent.labels).toEqual(labels);
  });

  it("trims whitespace around the parent label", () => {
    const agent = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "  parent-1 \n" } }),
      "server-1",
    );

    expect(agent.parentAgentId).toBe("parent-1");
  });

  it("maps missing, empty, and non-string parent labels to null", () => {
    const missing = normalizeAgentSnapshot(createSnapshot(), "server-1");
    const empty = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } }),
      "server-1",
    );
    const nonString = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } }),
      "server-1",
    );

    expect(missing.parentAgentId).toBeNull();
    expect(empty.parentAgentId).toBeNull();
    expect(nonString.parentAgentId).toBeNull();
  });
});
