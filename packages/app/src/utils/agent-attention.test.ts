import { describe, expect, it } from "vitest";

import { shouldClearAgentAttentionOnView } from "./agent-attention";

describe("shouldClearAgentAttentionOnView", () => {
  it("returns true only when the viewed agent is focused, connected, and requires attention", () => {
    expect(
      shouldClearAgentAttentionOnView({
        agentId: "agent-1",
        focusedAgentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      })
    ).toBe(true);
  });

  it("returns false when the app is disconnected", () => {
    expect(
      shouldClearAgentAttentionOnView({
        agentId: "agent-1",
        focusedAgentId: "agent-1",
        isConnected: false,
        requiresAttention: true,
        attentionReason: "finished",
      })
    ).toBe(false);
  });

  it("returns false when the agent is not focused", () => {
    expect(
      shouldClearAgentAttentionOnView({
        agentId: "agent-1",
        focusedAgentId: "agent-2",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      })
    ).toBe(false);
  });

  it("returns false when attention is already clear", () => {
    expect(
      shouldClearAgentAttentionOnView({
        agentId: "agent-1",
        focusedAgentId: "agent-1",
        isConnected: true,
        requiresAttention: false,
        attentionReason: null,
      })
    ).toBe(false);
  });

  it("returns false for empty agent ids", () => {
    expect(
      shouldClearAgentAttentionOnView({
        agentId: "",
        focusedAgentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "finished",
      })
    ).toBe(false);
  });

  it("returns false for permission-shaped attention", () => {
    expect(
      shouldClearAgentAttentionOnView({
        agentId: "agent-1",
        focusedAgentId: "agent-1",
        isConnected: true,
        requiresAttention: true,
        attentionReason: "permission",
      })
    ).toBe(false);
  });
});
