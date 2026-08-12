import { describe, expect, it } from "vitest";

import { AgentSnapshotPayloadSchema } from "./messages.js";

function baseSnapshot(): Record<string, unknown> {
  return {
    id: "agent-123",
    provider: "claude",
    cwd: "/tmp/project",
    model: "claude-opus-5",
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
    lastUserMessageAt: null,
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
    title: null,
    labels: {},
  };
}

describe("agent snapshot turn-progress fields", () => {
  it("parses a snapshot from a daemon that predates the fields", () => {
    const parsed = AgentSnapshotPayloadSchema.parse(baseSnapshot());

    expect(parsed.activeTurnOutputTokens).toBeUndefined();
    expect(parsed.activeTurnIdleMs).toBeUndefined();
  });

  it("round-trips both fields when the daemon sends them", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      ...baseSnapshot(),
      // The turn a count belongs to rides `activeTurn`; there is no second turn id on the wire.
      activeTurn: { turnId: "turn-7", startedAt: "2026-07-30T12:00:00.000Z" },
      activeTurnOutputTokens: 1234,
      activeTurnIdleMs: 45_000,
    });

    expect(parsed.activeTurn?.turnId).toBe("turn-7");
    expect(parsed.activeTurnOutputTokens).toBe(1234);
    expect(parsed.activeTurnIdleMs).toBe(45_000);
  });

  it("accepts a zero idle duration rather than treating it as absent", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      ...baseSnapshot(),
      activeTurnIdleMs: 0,
    });

    expect(parsed.activeTurnIdleMs).toBe(0);
  });

  it("rejects a non-numeric token count", () => {
    expect(() =>
      AgentSnapshotPayloadSchema.parse({
        ...baseSnapshot(),
        activeTurnOutputTokens: "1234",
      }),
    ).toThrow();
  });
});
