import { describe, expect, it } from "vitest";

import {
  applyTerminalRendererReadyChange,
  resolveTerminalStreamTarget,
  shouldReplayTerminalSnapshotForRenderer,
  shouldShowTerminalLoadingOverlay,
} from "./terminal-renderer-readiness";

describe("terminal-renderer-readiness", () => {
  it("preserves the attach loader even after the renderer is ready", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: false,
        isAttaching: true,
        rendererReadyStreamKey: "scope:terminal-1",
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(true);
  });

  it("keeps the loader visible until the current renderer is ready", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: false,
        isAttaching: false,
        rendererReadyStreamKey: null,
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(true);
  });

  it("hides the loader only after attach completes and the current renderer is ready", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: false,
        isAttaching: false,
        rendererReadyStreamKey: "scope:terminal-1",
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(false);
  });

  it("does not cover stream errors", () => {
    expect(
      shouldShowTerminalLoadingOverlay({
        isWorkspaceFocused: true,
        hasStreamError: true,
        isAttaching: true,
        rendererReadyStreamKey: null,
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(false);
  });

  it("ignores stale unready events from an old renderer", () => {
    const current = applyTerminalRendererReadyChange("scope:terminal-2", {
      streamKey: "scope:terminal-1",
      isReady: false,
    });

    expect(current).toBe("scope:terminal-2");
  });

  it("clears readiness when the current renderer unmounts", () => {
    const current = applyTerminalRendererReadyChange("scope:terminal-1", {
      streamKey: "scope:terminal-1",
      isReady: false,
    });

    expect(current).toBeNull();
  });

  it("replays snapshots only for ready events from the current renderer", () => {
    expect(
      shouldReplayTerminalSnapshotForRenderer({
        change: { streamKey: "scope:terminal-1", isReady: true },
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(true);
    expect(
      shouldReplayTerminalSnapshotForRenderer({
        change: { streamKey: "scope:terminal-1", isReady: false },
        terminalStreamKey: "scope:terminal-1",
      }),
    ).toBe(false);
    expect(
      shouldReplayTerminalSnapshotForRenderer({
        change: { streamKey: "scope:terminal-1", isReady: true },
        terminalStreamKey: "scope:terminal-2",
      }),
    ).toBe(false);
  });

  it("does not attach the stream before the matching renderer is ready", () => {
    expect(
      resolveTerminalStreamTarget({
        terminalId: "terminal-1",
        terminalStreamKey: "scope:terminal-1",
        rendererReadyStreamKey: null,
        isWorkspaceFocused: true,
      }),
    ).toBeNull();
  });

  it("attaches the stream after the matching renderer is ready", () => {
    expect(
      resolveTerminalStreamTarget({
        terminalId: "terminal-1",
        terminalStreamKey: "scope:terminal-1",
        rendererReadyStreamKey: "scope:terminal-1",
        isWorkspaceFocused: true,
      }),
    ).toBe("terminal-1");
  });

  it("detaches and restores the same stream across renderer replacement", () => {
    const targetForRenderer = (rendererReadyStreamKey: string | null) =>
      resolveTerminalStreamTarget({
        terminalId: "terminal-1",
        terminalStreamKey: "scope:terminal-1",
        rendererReadyStreamKey,
        isWorkspaceFocused: true,
      });

    expect([
      targetForRenderer("scope:terminal-1"),
      targetForRenderer(null),
      targetForRenderer("scope:terminal-1"),
    ]).toEqual(["terminal-1", null, "terminal-1"]);
  });
});
