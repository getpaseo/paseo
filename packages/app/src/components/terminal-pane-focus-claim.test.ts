import { describe, expect, it } from "vitest";
import {
  EMPTY_FOCUS_CLAIM_STATE,
  canRequestFocusClaim,
  reconcileFocusClaim,
  resolveTerminalResizeClaim,
  settleFocusClaim,
  type FocusClaimState,
} from "./terminal-pane-focus-claim";

function request(
  state: FocusClaimState,
  input: { key: string | null; canRequest: boolean },
): FocusClaimState {
  return reconcileFocusClaim(state, input).state;
}

describe("terminal pane focus claim", () => {
  it("forwards resize callbacks only from the active focused ready candidate", () => {
    const readiness = {
      isWorkspaceFocused: true,
      isAppActivelyVisible: true,
      isClientReady: true,
      isConnected: true,
      isRendererReady: true,
    };
    const candidates = [
      resolveTerminalResizeClaim({
        size: { rows: 30, cols: 90 },
        previousSentSize: null,
        shouldClaim: true,
        forceClaim: false,
        supportsTerminalSizeOwnership: true,
        readiness: { ...readiness, isPaneFocused: false },
      }),
      resolveTerminalResizeClaim({
        size: { rows: 42, cols: 120 },
        previousSentSize: null,
        shouldClaim: true,
        forceClaim: false,
        supportsTerminalSizeOwnership: true,
        readiness: { ...readiness, isPaneFocused: true },
      }),
    ];

    expect(candidates).toEqual([
      { shouldSend: false, intent: "claim" },
      { shouldSend: true, intent: "claim" },
    ]);
  });

  it("sends passive refits as owner-only updates and lets interaction reclaim the same size", () => {
    const readiness = {
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isAppActivelyVisible: true,
      isClientReady: true,
      isConnected: true,
      isRendererReady: true,
    };
    const size = { rows: 42, cols: 120 };

    const passiveRefit = resolveTerminalResizeClaim({
      size,
      previousSentSize: size,
      shouldClaim: false,
      forceClaim: false,
      supportsTerminalSizeOwnership: true,
      readiness,
    });
    const ordinarySameSizeMeasurement = resolveTerminalResizeClaim({
      size,
      previousSentSize: size,
      shouldClaim: true,
      forceClaim: false,
      supportsTerminalSizeOwnership: true,
      readiness,
    });
    const explicitReclaim = resolveTerminalResizeClaim({
      size,
      previousSentSize: size,
      shouldClaim: true,
      forceClaim: true,
      supportsTerminalSizeOwnership: true,
      readiness,
    });

    expect(passiveRefit).toEqual({ shouldSend: false, intent: "update" });
    expect(ordinarySameSizeMeasurement).toEqual({ shouldSend: true, intent: "claim" });
    expect(explicitReclaim.shouldSend).toBe(true);
  });

  it("lets the current owner update after pane focus moves without transferring ownership", () => {
    const result = resolveTerminalResizeClaim({
      size: { rows: 20, cols: 100 },
      previousSentSize: { rows: 40, cols: 100 },
      shouldClaim: false,
      forceClaim: false,
      supportsTerminalSizeOwnership: true,
      readiness: {
        isWorkspaceFocused: true,
        isPaneFocused: false,
        isAppActivelyVisible: true,
        isClientReady: true,
        isConnected: true,
        isRendererReady: true,
      },
    });

    expect(result).toEqual({ shouldSend: true, intent: "update" });
  });

  it("keeps passive refits local against legacy daemons", () => {
    const result = resolveTerminalResizeClaim({
      size: { rows: 20, cols: 100 },
      previousSentSize: { rows: 40, cols: 100 },
      shouldClaim: false,
      forceClaim: false,
      supportsTerminalSizeOwnership: false,
      readiness: {
        isWorkspaceFocused: true,
        isPaneFocused: true,
        isAppActivelyVisible: true,
        isClientReady: true,
        isConnected: true,
        isRendererReady: true,
      },
    });

    expect(result).toEqual({ shouldSend: false, intent: "update" });
  });

  it("waits for both the client and renderer before requesting a claim", () => {
    const withoutClient = canRequestFocusClaim({
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isAppActivelyVisible: true,
      isClientReady: false,
      isConnected: true,
      isRendererReady: true,
    });
    const withoutRenderer = canRequestFocusClaim({
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isAppActivelyVisible: true,
      isClientReady: true,
      isConnected: true,
      isRendererReady: false,
    });

    expect([withoutClient, withoutRenderer]).toEqual([false, false]);
  });

  it("does not deliver a requested claim after the host disconnects", () => {
    const disconnected = canRequestFocusClaim({
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isAppActivelyVisible: true,
      isClientReady: true,
      isConnected: false,
      isRendererReady: true,
    });

    expect(disconnected).toBe(false);
  });

  it("claims once per continuous pane-focus period after send", () => {
    const firstRequest = reconcileFocusClaim(EMPTY_FOCUS_CLAIM_STATE, {
      key: "ws:term-1",
      canRequest: true,
    });
    const sent = settleFocusClaim(firstRequest.state, {
      key: "ws:term-1",
      sent: true,
    });
    const repeated = reconcileFocusClaim(sent, {
      key: "ws:term-1",
      canRequest: true,
    });

    expect(firstRequest.shouldRequest).toBe(true);
    expect(repeated).toEqual({
      state: { claimedKey: "ws:term-1", requestedKey: null },
      shouldRequest: false,
    });
  });

  it("defers until the claim can be requested", () => {
    const unavailable = reconcileFocusClaim(EMPTY_FOCUS_CLAIM_STATE, {
      key: "ws:term-1",
      canRequest: false,
    });
    const available = reconcileFocusClaim(unavailable.state, {
      key: "ws:term-1",
      canRequest: true,
    });

    expect(unavailable.shouldRequest).toBe(false);
    expect(available.shouldRequest).toBe(true);
  });

  it("retries when readiness changes before the requested claim lands", () => {
    const requested = request(EMPTY_FOCUS_CLAIM_STATE, {
      key: "ws:term-1",
      canRequest: true,
    });
    const hiddenBeforeDelivery = request(requested, {
      key: "ws:term-1",
      canRequest: false,
    });
    const visibleAgain = reconcileFocusClaim(hiddenBeforeDelivery, {
      key: "ws:term-1",
      canRequest: true,
    });

    expect(visibleAgain).toEqual({
      state: { claimedKey: null, requestedKey: "ws:term-1" },
      shouldRequest: true,
    });
  });

  it("retries a requested claim that was not sent", () => {
    const requested = request(EMPTY_FOCUS_CLAIM_STATE, {
      key: "ws:term-1",
      canRequest: true,
    });
    const dropped = settleFocusClaim(requested, {
      key: "ws:term-1",
      sent: false,
    });
    const retry = reconcileFocusClaim(dropped, {
      key: "ws:term-1",
      canRequest: true,
    });

    expect(retry.shouldRequest).toBe(true);
  });

  it("re-arms after pane blur or terminal change", () => {
    const requested = request(EMPTY_FOCUS_CLAIM_STATE, {
      key: "ws:term-1",
      canRequest: true,
    });
    const sent = settleFocusClaim(requested, { key: "ws:term-1", sent: true });
    const blurred = request(sent, { key: null, canRequest: true });
    const refocused = reconcileFocusClaim(blurred, { key: "ws:term-1", canRequest: true });
    const changed = reconcileFocusClaim(sent, { key: "ws:term-2", canRequest: true });

    expect(refocused.shouldRequest).toBe(true);
    expect(changed.shouldRequest).toBe(true);
  });
});
