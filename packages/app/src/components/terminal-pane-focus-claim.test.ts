import { describe, expect, it } from "vitest";
import {
  EMPTY_FOCUS_CLAIM_STATE,
  EMPTY_PALETTE_SYNC_STATE,
  canRequestFocusClaim,
  reconcileFocusClaim,
  resolveTerminalPaletteSync,
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

describe("terminal pane palette sync", () => {
  const readyFocused = {
    isWorkspaceFocused: true,
    isPaneFocused: true,
    isAppActivelyVisible: true,
    isClientReady: true,
    isConnected: true,
  };

  it("claims on focus, skips duplicate sends, and re-claims on theme change or explicit focus", () => {
    const first = resolveTerminalPaletteSync(EMPTY_PALETTE_SYNC_STATE, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    expect(first).toMatchObject({ shouldSend: true, intent: "claim" });

    const duplicate = resolveTerminalPaletteSync(first.state, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    expect(duplicate.shouldSend).toBe(false);

    const themeFlipped = resolveTerminalPaletteSync(duplicate.state, {
      terminalKey: "ws:term-1",
      paletteKey: "dark",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    expect(themeFlipped).toMatchObject({ shouldSend: true, intent: "claim" });

    const explicitReclaim = resolveTerminalPaletteSync(themeFlipped.state, {
      terminalKey: "ws:term-1",
      paletteKey: "dark",
      forceClaim: true,
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    expect(explicitReclaim).toMatchObject({ shouldSend: true, intent: "claim" });
  });

  it("sends owner-only updates when theme changes while away and re-claims on return", () => {
    const claimed = resolveTerminalPaletteSync(EMPTY_PALETTE_SYNC_STATE, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    const inSettings = resolveTerminalPaletteSync(claimed.state, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: { ...readyFocused, isWorkspaceFocused: false },
    });
    expect(inSettings.shouldSend).toBe(false);

    const toggledInSettings = resolveTerminalPaletteSync(inSettings.state, {
      terminalKey: "ws:term-1",
      paletteKey: "dark",
      supportsTerminalPaletteOwnership: true,
      readiness: { ...readyFocused, isWorkspaceFocused: false },
    });
    expect(toggledInSettings).toMatchObject({ shouldSend: true, intent: "update" });

    const returned = resolveTerminalPaletteSync(toggledInSettings.state, {
      terminalKey: "ws:term-1",
      paletteKey: "dark",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    expect(returned).toMatchObject({ shouldSend: true, intent: "claim" });
  });

  it("never sends updates from an unfocused pane that has not claimed or against unsupported daemons", () => {
    const neverFocused = resolveTerminalPaletteSync(EMPTY_PALETTE_SYNC_STATE, {
      terminalKey: "ws:term-1",
      paletteKey: "dark",
      supportsTerminalPaletteOwnership: true,
      readiness: { ...readyFocused, isPaneFocused: false },
    });
    expect(neverFocused.shouldSend).toBe(false);

    const unsupported = resolveTerminalPaletteSync(EMPTY_PALETTE_SYNC_STATE, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: false,
      readiness: readyFocused,
    });
    expect(unsupported.shouldSend).toBe(false);
  });

  it("resets on disconnect so reconnect re-claims ownership on the fresh connection", () => {
    const claimed = resolveTerminalPaletteSync(EMPTY_PALETTE_SYNC_STATE, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    const disconnected = resolveTerminalPaletteSync(claimed.state, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: { ...readyFocused, isConnected: false },
    });
    const reconnected = resolveTerminalPaletteSync(disconnected.state, {
      terminalKey: "ws:term-1",
      paletteKey: "light",
      supportsTerminalPaletteOwnership: true,
      readiness: readyFocused,
    });
    expect(reconnected).toMatchObject({ shouldSend: true, intent: "claim" });
  });
});
