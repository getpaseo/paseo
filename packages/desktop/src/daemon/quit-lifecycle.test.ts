import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createBeforeQuitHandler,
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./quit-lifecycle";

const SETTINGS_KEEP_RUNNING = DEFAULT_DESKTOP_SETTINGS;
const SETTINGS_STOP_ON_QUIT = {
  ...DEFAULT_DESKTOP_SETTINGS,
  daemon: {
    ...DEFAULT_DESKTOP_SETTINGS.daemon,
    keepRunningAfterQuit: false,
  },
};

describe("quit-lifecycle", () => {
  it("only stops when keepRunningAfterQuit is explicitly disabled", () => {
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_STOP_ON_QUIT)).toBe(true);
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_KEEP_RUNNING)).toBe(false);
  });

  it("short-circuits without inspecting the daemon when keep-running is on", async () => {
    const isDesktopManagedDaemonRunning = vi.fn(() => true);
    const stopDaemon = vi.fn(async () => undefined);
    const showShutdownFeedback = vi.fn();

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_KEEP_RUNNING },
      isDesktopManagedDaemonRunning,
      stopDaemon,
      showShutdownFeedback,
    });

    expect(stopped).toBe(false);
    expect(isDesktopManagedDaemonRunning).not.toHaveBeenCalled();
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(showShutdownFeedback).not.toHaveBeenCalled();
  });

  it("does not stop a manually started daemon on quit", async () => {
    const stopDaemon = vi.fn(async () => undefined);
    const showShutdownFeedback = vi.fn();

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => false,
      stopDaemon,
      showShutdownFeedback,
    });

    expect(stopped).toBe(false);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(showShutdownFeedback).not.toHaveBeenCalled();
  });

  it("shows feedback then stops a desktop-managed daemon", async () => {
    const stopDaemon = vi.fn(async () => undefined);
    const showShutdownFeedback = vi.fn();

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon,
      showShutdownFeedback,
    });

    expect(stopped).toBe(true);
    expect(showShutdownFeedback).toHaveBeenCalledTimes(1);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(showShutdownFeedback.mock.invocationCallOrder[0]).toBeLessThan(
      stopDaemon.mock.invocationCallOrder[0],
    );
  });

  it("preventDefaults the first quit, runs the async stop decision, then exits hard", async () => {
    let resolveStopDecision: (() => void) | null = null;
    const app = { exit: vi.fn() };
    const closeTransportSessions = vi.fn();
    const onStopError = vi.fn();
    const preventDefault = vi.fn();
    const secondPreventDefault = vi.fn();

    const handleBeforeQuit = createBeforeQuitHandler({
      app,
      closeTransportSessions,
      stopDesktopManagedDaemonIfNeeded: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveStopDecision = () => resolve(false);
          }),
      ),
      onStopError,
    });

    handleBeforeQuit({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(closeTransportSessions).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
    expect(resolveStopDecision).not.toBeNull();

    resolveStopDecision?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.exit).toHaveBeenCalledWith(0);
    expect(onStopError).not.toHaveBeenCalled();

    handleBeforeQuit({ preventDefault: secondPreventDefault });

    expect(secondPreventDefault).not.toHaveBeenCalled();
    expect(closeTransportSessions).toHaveBeenCalledTimes(2);
    expect(app.exit).toHaveBeenCalledTimes(1);
  });
});
