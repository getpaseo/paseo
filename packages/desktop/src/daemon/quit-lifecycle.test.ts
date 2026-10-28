import { describe, expect, it } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./quit-lifecycle";

const SETTINGS_STOP_ON_QUIT = DEFAULT_DESKTOP_SETTINGS;
const SETTINGS_KEEP_RUNNING = {
  ...DEFAULT_DESKTOP_SETTINGS,
  daemon: {
    ...DEFAULT_DESKTOP_SETTINGS.daemon,
    keepRunningAfterQuit: true,
  },
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitForQuitLifecycle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("quit-lifecycle", () => {
  it("turns external termination signals into one Electron quit", () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const quits: string[] = [];

    registerExternalQuitSignals({
      signals: {
        on: (signal, listener) => {
          listeners.set(signal, listener);
        },
      },
      quit: () => quits.push("quit"),
    });

    expect(Array.from(listeners.keys())).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    listeners.get("SIGTERM")?.();
    listeners.get("SIGHUP")?.();
    expect(quits).toEqual(["quit"]);
  });

  it("stops by default and only keeps running when keepRunningAfterQuit is enabled", () => {
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

  it("stops the daemon before exiting and ignores a repeated quit", async () => {
    const stopDecision = deferred<boolean>();
    const events: string[] = [];

    const quitLifecycle = createQuitLifecycle({
      app: {
        exit: (code) => {
          events.push(`exit:${code}`);
        },
      },
      closeTransportSessions: () => {
        events.push("close-transports");
      },
      stopDesktopManagedDaemonIfNeeded: () => stopDecision.promise,
      onStopError: () => {
        events.push("stop-error");
      },
      onFlushError: () => {},
    });

    quitLifecycle.handleBeforeQuit({
      preventDefault: () => {
        events.push("prevent-default");
      },
    });

    expect(events).toEqual(["close-transports", "prevent-default"]);

    events.push("daemon-stopped");
    stopDecision.resolve(false);
    await waitForQuitLifecycle();

    expect(events).toEqual(["close-transports", "prevent-default", "daemon-stopped", "exit:0"]);

    quitLifecycle.handleBeforeQuit({
      preventDefault: () => {
        events.push("second-prevent-default");
      },
    });

    expect(events.at(-1)).toBe("close-transports");
    expect(events).not.toContain("second-prevent-default");
  });

  it("still exits when stopping the daemon fails", async () => {
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => {
        throw new Error("daemon stop failed");
      },
      onStopError: () => {
        events.push("stop-error");
      },
      onFlushError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();

    expect(events).toEqual(["stop-error", "exit:0"]);
  });

  it("waits for the pending update flush before exiting", async () => {
    const events: string[] = [];
    let releaseFlush!: () => void;
    const flushPendingUpdate = () =>
      new Promise<void>((resolve) => {
        releaseFlush = () => {
          events.push("flushed");
          resolve();
        };
      });

    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      onStopError: () => {},
      onFlushError: () => {},
      flushPendingUpdate,
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();

    // Exit must not happen while the marker write is still in flight.
    expect(events).toEqual([]);

    releaseFlush();
    await waitForQuitLifecycle();

    expect(events).toEqual(["flushed", "exit:0"]);
  });

  it("exits even when the pending update flush rejects", async () => {
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      onStopError: () => {},
      onFlushError: () => {
        events.push("flush-error");
      },
      flushPendingUpdate: async () => {
        throw new Error("disk full");
      },
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();

    expect(events).toEqual(["flush-error", "exit:0"]);
  });

  it("exits when the pending update flush never settles", async () => {
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      onStopError: () => {},
      onFlushError: () => {},
      flushPendingUpdate: () => new Promise<void>(() => {}),
      flushDeadlineMs: 5,
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();

    expect(events).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual(["exit:0"]);
  });
});
