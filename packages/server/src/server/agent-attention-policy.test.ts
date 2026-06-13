import { describe, expect, it } from "vitest";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
  PRESENCE_THRESHOLD_MS,
} from "./agent-attention-policy.js";

function state(overrides: Partial<ClientPresenceState>): ClientPresenceState {
  return {
    appVisible: true,
    focusedAgentId: null,
    focusedTerminalId: null,
    lastActivityAtMs: null,
    ...overrides,
  };
}

describe("computeNotificationPlan", () => {
  const nowMs = Date.parse("2026-04-19T12:00:00.000Z");
  const staleAtMs = nowMs - PRESENCE_THRESHOLD_MS - 1;
  const presentAtMs = nowMs - PRESENCE_THRESHOLD_MS + 1;

  it("does not suppress notifications when a focused client is stale", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("suppresses notifications when a focused client is present", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });
    const presentFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused, presentFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("does not suppress notifications when a focused client is backgrounded", () => {
    const backgroundFocused = state({
      appVisible: false,
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [backgroundFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("treats present clients focused on different agents as eligible", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({
            focusedAgentId: "agent-2",
            lastActivityAtMs: nowMs - 1_000,
          }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("chooses the present client with the greatest clamped activity timestamp", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 10_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: staleAtMs }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("uses the lower index when present clients have identical timestamps", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("clamps future timestamps to now and treats them as present", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1 }),
          state({ lastActivityAtMs: nowMs + 600_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("never treats no-heartbeat clients as present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: null })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("falls back to push for non-error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("does not push error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("lets a foreground mobile-style client with recent activity win as most recent", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ focusedAgentId: "agent-2", lastActivityAtMs: nowMs - 20_000 }),
          state({ focusedAgentId: null, lastActivityAtMs: nowMs - 500 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, shouldPush: false });
  });

  it("selects no in-app recipient and pushes when two web-style clients are stale", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs }), state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });

  it("never suppresses when focusTarget is null even if a client focuses a matching id", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ focusedAgentId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: null,
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, shouldPush: false });
  });

  it("suppresses terminal notifications when a present visible client focuses the terminal", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ focusedTerminalId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: { kind: "terminal", id: "terminal-1" },
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: false });
  });

  it("pushes for a null-focus target when no client is present and push is eligible", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: null,
        pushEligible: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, shouldPush: true });
  });
});

describe("isPushEligibleAttentionReason", () => {
  it("allows push for finished and permission but not error", () => {
    expect(isPushEligibleAttentionReason("finished")).toBe(true);
    expect(isPushEligibleAttentionReason("permission")).toBe(true);
    expect(isPushEligibleAttentionReason("error")).toBe(false);
  });
});
