import { describe, expect, it } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createQuitLifecycle,
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
    const stopDecision = deferred<boolean>();
    const updateDecision = deferred<boolean>();
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
      installAppUpdateOnQuit: () => updateDecision.promise,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => {
        events.push("stop-error");
      },
      onUpdateError: () => {
        events.push("update-error");
      },
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

    expect(events).toEqual(["close-transports", "prevent-default", "daemon-stopped"]);

    events.push("update-checked");
    updateDecision.resolve(false);
    await waitForQuitLifecycle();

    expect(events).toEqual([
      "close-transports",
      "prevent-default",
      "daemon-stopped",
      "update-checked",
      "exit:0",
    ]);

    quitLifecycle.handleBeforeQuit({
      preventDefault: () => {
        events.push("second-prevent-default");
      },
    });

    expect(events.at(-1)).toBe("close-transports");
    expect(events).not.toContain("second-prevent-default");
  });

  it("lets the updater own process exit when a validated update is installing", async () => {
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuitForUpdate();
    await waitForQuitLifecycle();

    expect(exits).toEqual([]);
  });

  it("recognizes a repeated quit as updater handoff", async () => {
    const exits: number[] = [];
    let preventedQuitCount = 0;
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    await waitForQuitLifecycle();

    expect(preventedQuitCount).toBe(1);
    expect(exits).toEqual([]);
  });

  it("exits when the updater does not take ownership before its deadline", async () => {
    const revalidationDeadline = new AbortController();
    const handoffDeadline = new AbortController();
    let deadlineCount = 0;
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () =>
        deadlineCount++ === 0 ? revalidationDeadline.signal : handoffDeadline.signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    handoffDeadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([0]);
  });

  it("does not intercept a quit started by a manual update", () => {
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("stop-daemon");
        return false;
      },
      installAppUpdateOnQuit: async () => {
        events.push("revalidate-update");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });

    quitLifecycle.handleBeforeQuitForUpdate();
    quitLifecycle.handleBeforeQuit({
      preventDefault: () => events.push("prevent-default"),
    });

    expect(events).toEqual(["close-transports"]);
  });

  it("exits when update revalidation reaches its deadline", async () => {
    const deadline = new AbortController();
    const updateDecision = deferred<boolean>();
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: () => updateDecision.promise,
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    deadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([0]);

    updateDecision.resolve(true);
    await waitForQuitLifecycle();
    expect(exits).toEqual([0]);
  });
});
