import { describe, expect, it } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
  type QuitConfirmationGate,
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

/**
 * A gate for a quit the user has already agreed to. Every test that predates the
 * confirmation dialog uses this so it exercises the same path it always did.
 */
function committedGate(): QuitConfirmationGate {
  return {
    isQuitCommitted: () => true,
    shouldConfirm: () => false,
    requestConfirmation: async () => true,
    commit: () => {},
  };
}

/**
 * A gate for a quit that needs no dialog and has not been committed yet: no
 * managed daemon is running, or keepRunningAfterQuit is on. Distinct from
 * committedGate(), whose latch is hardwired true and so cannot observe whether
 * the lifecycle sets it.
 */
function silentGate(): QuitConfirmationGate {
  let committed = false;
  return {
    isQuitCommitted: () => committed,
    shouldConfirm: () => false,
    requestConfirmation: async () => true,
    commit() {
      committed = true;
    },
  };
}

/** A gate that will ask, backed by a dialog the test resolves by hand. */
function askingGate(): QuitConfirmationGate & {
  answer(confirmed: boolean): void;
  askCount(): number;
} {
  let committed = false;
  let asks = 0;
  let resolveAsk: ((confirmed: boolean) => void) | null = null;

  return {
    isQuitCommitted: () => committed,
    shouldConfirm: () => !committed,
    requestConfirmation() {
      asks++;
      return new Promise<boolean>((resolve) => {
        resolveAsk = resolve;
      });
    },
    commit() {
      committed = true;
    },
    answer(confirmed: boolean) {
      if (confirmed) {
        committed = true;
      }
      resolveAsk?.(confirmed);
      resolveAsk = null;
    },
    askCount: () => asks,
  };
}

function countQuits(events: readonly string[]): number {
  return events.filter((event) => event === "quit").length;
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

  it("honours the one-shot override over a stop-on-quit setting", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      // Settings say stop; the user just said otherwise in the dialog.
      settingsStore: {
        get: async () => {
          events.push("read-settings");
          return SETTINGS_STOP_ON_QUIT;
        },
      },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
      keepDaemonRunningThisQuit: () => true,
    });

    expect(stopped).toBe(false);
    // No shutdown overlay either, since nothing is being shut down.
    expect(events).toEqual([]);
  });

  it("stops the daemon when the override is present but false", async () => {
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
      keepDaemonRunningThisQuit: () => false,
    });

    expect(stopped).toBe(true);
    expect(events).toEqual(["feedback", "stop"]);
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
      quitConfirmation: committedGate(),
      app: {
        exit: (code) => {
          events.push(`exit:${code}`);
        },
        quit: () => {
          events.push("quit");
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
      quitConfirmation: committedGate(),
      app: { exit: (code) => exits.push(code), quit: () => {} },
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
      quitConfirmation: committedGate(),
      app: { exit: (code) => exits.push(code), quit: () => {} },
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
      quitConfirmation: committedGate(),
      app: { exit: (code) => exits.push(code), quit: () => {} },
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
      quitConfirmation: committedGate(),
      app: { exit: (code) => events.push(`exit:${code}`), quit: () => {} },
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
      quitConfirmation: committedGate(),
      app: { exit: (code) => exits.push(code), quit: () => {} },
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

  describe("confirmation gate", () => {
    function createGatedLifecycle(gate: QuitConfirmationGate) {
      const events: string[] = [];
      const quitLifecycle = createQuitLifecycle({
        quitConfirmation: gate,
        app: {
          exit: (code) => events.push(`exit:${code}`),
          quit: () => events.push("quit"),
        },
        closeTransportSessions: () => events.push("close-transports"),
        stopDesktopManagedDaemonIfNeeded: async () => {
          events.push("stop-daemon");
          return false;
        },
        installAppUpdateOnQuit: async () => {
          events.push("install-update");
          return false;
        },
        createUpdateDeadlineSignal: () => new AbortController().signal,
        onStopError: () => events.push("stop-error"),
        onUpdateError: () => events.push("update-error"),
      });
      return { quitLifecycle, events };
    }

    // The whole point of the gate: a quit the user is still being asked about
    // must not close transport sessions (which deletes them and drops the
    // renderer into reconnect), stop the daemon, or exit.
    it("runs no side effects while the user is being asked", async () => {
      const gate = askingGate();
      const { quitLifecycle, events } = createGatedLifecycle(gate);
      let prevented = 0;

      quitLifecycle.handleBeforeQuit({ preventDefault: () => prevented++ });
      await waitForQuitLifecycle();

      expect(prevented).toBe(1);
      expect(events).toEqual([]);
      expect(gate.askCount()).toBe(1);
    });

    it("leaves the app fully alive after the user cancels", async () => {
      const gate = askingGate();
      const { quitLifecycle, events } = createGatedLifecycle(gate);

      quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
      gate.answer(false);
      await waitForQuitLifecycle();

      expect(events).toEqual([]);
    });

    it("re-fires the quit exactly once after the user confirms", async () => {
      const gate = askingGate();
      const { quitLifecycle, events } = createGatedLifecycle(gate);

      // Two quit paths (the close veto and before-quit) can both veto one quit.
      quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
      quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
      gate.answer(true);
      await waitForQuitLifecycle();

      expect(countQuits(events)).toBe(1);
    });

    it("proceeds without asking once the quit is committed", async () => {
      const { quitLifecycle, events } = createGatedLifecycle(committedGate());

      quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
      await waitForQuitLifecycle();

      expect(events).toEqual(["close-transports", "stop-daemon", "install-update", "exit:0"]);
    });

    // Regression: a quit that skips the dialog used to leave the latch false all
    // the way to app.exit(0). Window geometry flushes from a before-quit listener
    // gated on that latch, and app.exit(0) fires no window close event, so the
    // last resize or move was silently dropped on every unprompted quit.
    it("commits the latch for a quit that never needed a dialog", async () => {
      const gate = silentGate();
      const { quitLifecycle, events } = createGatedLifecycle(gate);

      quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });

      // Synchronously, while the before-quit listeners are still running: the
      // geometry flush is one of them and reads the latch during this emit.
      expect(gate.isQuitCommitted()).toBe(true);

      await waitForQuitLifecycle();
      expect(events).toEqual(["close-transports", "stop-daemon", "install-update", "exit:0"]);
    });

    it("keeps the dialog out of the auto-update path", () => {
      const gate = askingGate();
      const { quitLifecycle, events } = createGatedLifecycle(gate);

      quitLifecycle.handleBeforeQuitForUpdate();
      quitLifecycle.handleBeforeQuit({ preventDefault: () => events.push("prevent-default") });

      expect(gate.askCount()).toBe(0);
      expect(gate.isQuitCommitted()).toBe(true);
      expect(events).toEqual(["close-transports"]);
    });
  });

  // Regression: any second app.quit() used to count as MacUpdater handoff
  // evidence. A user pressing Cmd+Q again during the multi-second daemon stop
  // therefore convinced the lifecycle that the updater owned process exit, and
  // it returned without ever calling app.exit(0) — an app that never quits.
  it("does not mistake an impatient second quit for updater handoff", async () => {
    const stopDecision = deferred<boolean>();
    const handoffDeadline = new AbortController();
    let deadlineCount = 0;
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      quitConfirmation: committedGate(),
      app: { exit: (code) => exits.push(code), quit: () => {} },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: () => stopDecision.promise,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () =>
        deadlineCount++ === 0 ? new AbortController().signal : handoffDeadline.signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    // Second Cmd+Q while the daemon is still stopping — before any install began.
    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();

    stopDecision.resolve(false);
    await waitForQuitLifecycle();
    await waitForQuitLifecycle();

    // No real handoff ever arrives, so the deadline must be what ends the wait.
    // Before the fix the premature quit had already resolved the handoff and the
    // lifecycle returned early, leaving `exits` empty forever.
    handoffDeadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([0]);
  });

  it("still treats a quit after the install began as updater handoff", async () => {
    const handoffDeadline = new AbortController();
    let deadlineCount = 0;
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      quitConfirmation: committedGate(),
      app: { exit: (code) => exits.push(code), quit: () => {} },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => true,
      createUpdateDeadlineSignal: () =>
        deadlineCount++ === 0 ? new AbortController().signal : handoffDeadline.signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    // MacUpdater's no-relaunch path: app.quit() with no before-quit-for-update.
    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();

    // The updater owns process exit from here; aborting the deadline must not
    // make us exit out from under it.
    handoffDeadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([]);
  });
});
