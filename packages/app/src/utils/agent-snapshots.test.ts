import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { normalizeAgentSnapshot } from "./agent-snapshots";

function createSnapshot(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    labels?: Record<string, unknown>;
  } = {},
): AgentSnapshotPayload {
  return {
    id: input.id ?? "agent-1",
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
    activeTurn: input.activeTurn,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    title: input.title ?? null,
    activeTurnOutputTokens: input.activeTurnOutputTokens,
    activeTurnIdleMs: input.activeTurnIdleMs,
    labels: (input.labels ?? {}) as AgentSnapshotPayload["labels"],
  };
}

describe("normalizeAgentSnapshot", () => {
  it("normalizes identified and legacy active turns at the snapshot boundary", () => {
    const startedAt = "2026-07-31T12:00:00.000Z";
    expect(
      normalizeAgentSnapshot(
        createSnapshot({
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt },
        }),
        "server-1",
      ).activeTurn,
    ).toEqual({ turnId: "turn-1", startedAt: new Date(startedAt) });

    expect(
      normalizeAgentSnapshot(
        createSnapshot({ status: "running", lastUserMessageAt: startedAt }),
        "server-1",
      ).activeTurn,
    ).toEqual({ turnId: null, startedAt: new Date(startedAt) });
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

  it("passes live turn progress through and stamps when the idle duration arrived", () => {
    const receivedAt = new Date("2026-04-20T00:01:30.000Z");

    const agent = normalizeAgentSnapshot(
      createSnapshot({
        activeTurnOutputTokens: 1_234,
        activeTurnIdleMs: 5_000,
      }),
      "server-1",
      receivedAt,
    );
    expect(agent.activeTurnOutputTokens).toBe(1_234);
    expect(agent.activeTurnIdleMs).toBe(5_000);
    // The receipt instant is the client's clock; the duration is the daemon's. Pairing them
    // here is what lets the stall resolver add elapsed time without comparing the two clocks.
    expect(agent.activeTurnIdleReceivedAt).toBe(receivedAt);
  });

  it("leaves the receipt instant unset when the daemon reports no idle duration", () => {
    const agent = normalizeAgentSnapshot(createSnapshot(), "server-1", new Date());
    expect(agent.activeTurnOutputTokens).toBeUndefined();
    expect(agent.activeTurnIdleMs).toBeUndefined();
    expect(agent.activeTurnIdleReceivedAt).toBeUndefined();
  });
});
