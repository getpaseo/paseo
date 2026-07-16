import { describe, expect, it } from "vitest";

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
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_KEEP_RUNNING },
      isDesktopManagedDaemonRunning: () => {
        events.push("inspect");
        return true;
      },
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not stop a manually started daemon on quit", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => false,
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("shows feedback then stops a desktop-managed daemon", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(true);
    expect(events).toEqual(["feedback", "stop"]);
  });

  it("revalidates updates after daemon shutdown before exiting", async () => {
    let resolveStopDecision: (() => void) | null = null;
    let resolveUpdateDecision: (() => void) | null = null;
    const events: string[] = [];

    const handleBeforeQuit = createBeforeQuitHandler({
      app: {
        exit: (code) => {
          events.push(`exit:${code}`);
        },
      },
      closeTransportSessions: () => {
        events.push("close-transports");
      },
      stopDesktopManagedDaemonIfNeeded: () =>
        new Promise<boolean>((resolve) => {
          resolveStopDecision = () => {
            events.push("daemon-stopped");
            resolve(false);
          };
        }),
      installAppUpdateOnQuit: () =>
        new Promise<boolean>((resolve) => {
          resolveUpdateDecision = () => {
            events.push("update-checked");
            resolve(false);
          };
        }),
      onStopError: () => {
        events.push("stop-error");
      },
      onUpdateError: () => {
        events.push("update-error");
      },
    });

    handleBeforeQuit({
      preventDefault: () => {
        events.push("prevent-default");
      },
    });

    expect(events).toEqual(["close-transports", "prevent-default"]);
    expect(resolveStopDecision).not.toBeNull();

    resolveStopDecision?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["close-transports", "prevent-default", "daemon-stopped"]);
    expect(resolveUpdateDecision).not.toBeNull();

    resolveUpdateDecision?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([
      "close-transports",
      "prevent-default",
      "daemon-stopped",
      "update-checked",
      "exit:0",
    ]);

    handleBeforeQuit({
      preventDefault: () => {
        events.push("second-prevent-default");
      },
    });

    expect(events.at(-1)).toBe("close-transports");
    expect(events).not.toContain("second-prevent-default");
  });

  it("lets the updater own process exit when a validated update is installing", async () => {
    const exits: number[] = [];
    const handleBeforeQuit = createBeforeQuitHandler({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    handleBeforeQuit({ preventDefault: () => {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([]);
  });
});
