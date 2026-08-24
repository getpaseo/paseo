import { describe, expect, it, vi } from "vitest";

import {
  createQuitConfirmation,
  selectDialogParentWindow,
  type QuitConfirmationCopy,
  type QuitConfirmationDeps,
  type QuitConfirmationDialogResult,
} from "./quit-confirmation.js";

const COPY: QuitConfirmationCopy = {
  title: "Quit Paseo?",
  message: "Quitting stops the local daemon and any running agents.",
  quitLabel: "Quit",
  cancelLabel: "Cancel",
  keepDaemonRunningLabel: "Leave the daemon running",
};

function createDeps(overrides: Partial<QuitConfirmationDeps> = {}): {
  deps: QuitConfirmationDeps;
  showDialog: QuitConfirmationDeps["showDialog"];
  onError: QuitConfirmationDeps["onError"];
} {
  const deps: QuitConfirmationDeps = {
    readSettingsSync: () => ({
      daemon: { keepRunningAfterQuit: false },
    }),
    isAppReady: () => true,
    hasOpenWindows: () => true,
    isDesktopManagedDaemonRunning: () => true,
    loadCopy: () => COPY,
    showDialog: vi.fn(
      async (): Promise<QuitConfirmationDialogResult> => ({
        confirmed: true,
        keepDaemonRunning: false,
      }),
    ),
    onError: vi.fn(),
    ...overrides,
  };

  // Read the spies back off `deps` so an override is what the test asserts on.
  return {
    deps,
    showDialog: deps.showDialog,
    onError: deps.onError,
  };
}

describe("selectDialogParentWindow", () => {
  function fakeWindow(state: {
    destroyed?: boolean;
    visible?: boolean;
    minimized?: boolean;
    focused?: boolean;
    id?: string;
  }) {
    return {
      id: state.id ?? "win",
      isDestroyed: () => state.destroyed ?? false,
      isVisible: () => state.visible ?? true,
      isMinimized: () => state.minimized ?? false,
      isFocused: () => state.focused ?? false,
    };
  }

  it("prefers the focused window", () => {
    const focused = fakeWindow({ focused: true, id: "focused" });
    const other = fakeWindow({ id: "other" });

    expect(selectDialogParentWindow([other, focused])?.id).toBe("focused");
  });

  // A sheet on a Cmd+H-hidden or minimized window is invisible; the app looks hung.
  it("skips hidden and minimized windows", () => {
    const hidden = fakeWindow({ visible: false, id: "hidden" });
    const minimized = fakeWindow({ minimized: true, id: "minimized" });
    const usable = fakeWindow({ id: "usable" });

    expect(selectDialogParentWindow([hidden, minimized, usable])?.id).toBe("usable");
  });

  it("skips destroyed windows", () => {
    const destroyed = fakeWindow({ destroyed: true, id: "destroyed" });

    expect(selectDialogParentWindow([destroyed])).toBeNull();
  });

  it("falls back to no parent when nothing is showable", () => {
    expect(selectDialogParentWindow([])).toBeNull();
    expect(selectDialogParentWindow([fakeWindow({ visible: false })])).toBeNull();
  });
});

describe("quit-confirmation shouldConfirm", () => {
  it("asks for the default configuration with a managed daemon running", () => {
    const { deps } = createDeps();

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(true);
  });

  it("is synchronous", () => {
    const { deps } = createDeps();

    // The before-quit handler calls this ahead of the synchronous
    // event.preventDefault(); a thenable here would break that ordering.
    expect(createQuitConfirmation(deps).shouldConfirm()).not.toBeInstanceOf(Promise);
  });

  it("does not ask when the daemon is configured to outlive the app", () => {
    const { deps } = createDeps({
      readSettingsSync: () => ({
        daemon: { keepRunningAfterQuit: true },
      }),
    });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
  });

  it("does not ask when no desktop-managed daemon is running", () => {
    const { deps } = createDeps({ isDesktopManagedDaemonRunning: () => false });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
  });

  // The single-instance lock calls app.quit() during startup, before whenReady().
  it("does not ask before the app is ready", () => {
    const { deps } = createDeps({ isAppReady: () => false });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
  });

  it("does not ask when there is no window to parent a dialog to", () => {
    const { deps } = createDeps({ hasOpenWindows: () => false });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
  });

  it("does not ask when settings have not loaded yet", () => {
    const { deps } = createDeps({ readSettingsSync: () => null });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
  });

  it("fails open and reports when reading settings throws", () => {
    const { deps, onError } = createDeps({
      readSettingsSync: () => {
        throw new Error("cache exploded");
      },
    });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("fails open and reports when the daemon check throws", () => {
    const { deps, onError } = createDeps({
      isDesktopManagedDaemonRunning: () => {
        throw new Error("no daemon handle");
      },
    });

    expect(createQuitConfirmation(deps).shouldConfirm()).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("stops asking once the quit is committed", () => {
    const { deps } = createDeps();
    const confirmation = createQuitConfirmation(deps);

    confirmation.commit();

    expect(confirmation.shouldConfirm()).toBe(false);
    expect(confirmation.isQuitCommitted()).toBe(true);
  });
});

describe("quit-confirmation requestConfirmation", () => {
  it("commits the quit when the user confirms", async () => {
    const { deps } = createDeps();
    const confirmation = createQuitConfirmation(deps);

    await expect(confirmation.requestConfirmation()).resolves.toBe(true);
    expect(confirmation.isQuitCommitted()).toBe(true);
    expect(confirmation.shouldKeepDaemonRunningThisQuit()).toBe(false);
  });

  it("leaves the quit uncommitted and re-askable after Cancel", async () => {
    const { deps, showDialog } = createDeps({
      showDialog: vi.fn(async () => ({ confirmed: false, keepDaemonRunning: false })),
    });
    const confirmation = createQuitConfirmation(deps);

    await expect(confirmation.requestConfirmation()).resolves.toBe(false);
    expect(confirmation.isQuitCommitted()).toBe(false);

    // The next Cmd+Q must show the dialog again, not silently quit or silently hang.
    await expect(confirmation.requestConfirmation()).resolves.toBe(false);
    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it("shows a single dialog when two quit paths race", async () => {
    let releaseDialog!: (result: QuitConfirmationDialogResult) => void;
    const showDialog = vi.fn(
      () =>
        new Promise<QuitConfirmationDialogResult>((resolve) => {
          releaseDialog = resolve;
        }),
    );
    const { deps } = createDeps({ showDialog });
    const confirmation = createQuitConfirmation(deps);

    const first = confirmation.requestConfirmation();
    const second = confirmation.requestConfirmation();
    releaseDialog({ confirmed: true, keepDaemonRunning: false });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(showDialog).toHaveBeenCalledOnce();
  });

  it("carries the ticked checkbox to the quit that follows", async () => {
    const { deps } = createDeps({
      showDialog: vi.fn(async () => ({ confirmed: true, keepDaemonRunning: true })),
    });
    const confirmation = createQuitConfirmation(deps);

    await expect(confirmation.requestConfirmation()).resolves.toBe(true);

    // The stop-on-quit step runs after the re-fired quit, long after the dialog
    // has closed, so the answer has to outlive it.
    expect(confirmation.shouldKeepDaemonRunningThisQuit()).toBe(true);
  });

  it("ignores the checkbox when the user cancels", async () => {
    const { deps, showDialog } = createDeps({
      showDialog: vi.fn(async () => ({ confirmed: false, keepDaemonRunning: true })),
    });
    const confirmation = createQuitConfirmation(deps);

    await expect(confirmation.requestConfirmation()).resolves.toBe(false);
    expect(confirmation.isQuitCommitted()).toBe(false);

    // A checkbox ticked alongside Cancel decided nothing. Leaking it into the
    // next quit would silently keep the daemon alive on a quit nobody asked
    // that question about.
    expect(confirmation.shouldKeepDaemonRunningThisQuit()).toBe(false);

    await confirmation.requestConfirmation();
    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it("fails open when the dialog throws", async () => {
    const { deps, onError } = createDeps({
      showDialog: vi.fn(async () => {
        throw new Error("no display");
      }),
    });
    const confirmation = createQuitConfirmation(deps);

    // Rejecting would strand a preventDefault()ed quit with nothing to re-fire it.
    await expect(confirmation.requestConfirmation()).resolves.toBe(true);
    expect(confirmation.isQuitCommitted()).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("stops the daemon when the dialog fails open", async () => {
    const { deps, onError } = createDeps({
      showDialog: vi.fn(async () => {
        throw new Error("no display");
      }),
    });
    const confirmation = createQuitConfirmation(deps);

    await expect(confirmation.requestConfirmation()).resolves.toBe(true);
    expect(onError).toHaveBeenCalledOnce();

    // Failing open must not also invent a "leave it running" the user never
    // chose; the stored preference decides, exactly as it did before.
    expect(confirmation.shouldKeepDaemonRunningThisQuit()).toBe(false);
  });

  it("skips the dialog entirely once committed by the update path", async () => {
    const { deps, showDialog } = createDeps();
    const confirmation = createQuitConfirmation(deps);

    confirmation.commit();

    await expect(confirmation.requestConfirmation()).resolves.toBe(true);
    expect(showDialog).not.toHaveBeenCalled();
  });
});
