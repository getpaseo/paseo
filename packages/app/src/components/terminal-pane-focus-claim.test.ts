import { describe, expect, it } from "vitest";
import {
  EMPTY_FOCUS_CLAIM_STATE,
  canRequestFocusClaim,
  reconcileFocusClaim,
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
  it("waits for both the client and renderer before requesting a claim", () => {
    const withoutClient = canRequestFocusClaim({
      isWorkspaceFocused: true,
      isAppActivelyVisible: true,
      isClientReady: false,
      isConnected: true,
      isRendererReady: true,
    });
    const withoutRenderer = canRequestFocusClaim({
      isWorkspaceFocused: true,
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
