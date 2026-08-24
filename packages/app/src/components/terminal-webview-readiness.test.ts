import { describe, expect, it } from "vitest";
import { shouldResetForMissingRendererReady } from "./terminal-webview-readiness";

describe("legacy terminal WebView readiness", () => {
  it("resets when a requested mount never reports renderer readiness", () => {
    expect(
      shouldResetForMissingRendererReady({
        expectedReadyVersion: 0,
        currentReadyVersion: 0,
        expectedStreamKey: "terminal-a",
        mountRequestedStreamKey: "terminal-a",
        rendererReadyStreamKey: null,
      }),
    ).toBe(true);
  });

  it("keeps the document after the requested renderer confirms readiness", () => {
    expect(
      shouldResetForMissingRendererReady({
        expectedReadyVersion: 0,
        currentReadyVersion: 0,
        expectedStreamKey: "terminal-a",
        mountRequestedStreamKey: "terminal-a",
        rendererReadyStreamKey: "terminal-a",
      }),
    ).toBe(false);
  });

  it("ignores a watchdog from an earlier ready generation", () => {
    expect(
      shouldResetForMissingRendererReady({
        expectedReadyVersion: 0,
        currentReadyVersion: 1,
        expectedStreamKey: "terminal-a",
        mountRequestedStreamKey: "terminal-a",
        rendererReadyStreamKey: null,
      }),
    ).toBe(false);
  });

  it("does not let readiness from a stale stream satisfy the requested mount", () => {
    expect(
      shouldResetForMissingRendererReady({
        expectedReadyVersion: 0,
        currentReadyVersion: 0,
        expectedStreamKey: "terminal-b",
        mountRequestedStreamKey: "terminal-b",
        rendererReadyStreamKey: "terminal-a",
      }),
    ).toBe(true);
  });

  it("does not reset a newer mount from an expired watchdog", () => {
    expect(
      shouldResetForMissingRendererReady({
        expectedReadyVersion: 0,
        currentReadyVersion: 0,
        expectedStreamKey: "terminal-a",
        mountRequestedStreamKey: "terminal-b",
        rendererReadyStreamKey: null,
      }),
    ).toBe(false);
  });
});
