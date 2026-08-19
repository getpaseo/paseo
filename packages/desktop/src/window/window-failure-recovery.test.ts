import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupWindowFailureRecovery } from "./window-manager";

// vi.mock's factory is hoisted above module scope, so the spy has to be hoisted with it.
const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock("electron", () => ({
  app: { name: "Paseo", on: vi.fn(), removeListener: vi.fn(), getPath: vi.fn(() => "") },
  // window-manager reaches for BrowserWindow.fromWebContents in paths this test never enters,
  // so a stub object is enough and avoids an empty class.
  BrowserWindow: { fromWebContents: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn() },
}));

/**
 * The recovery path is a state machine over three events and three buttons, and review found
 * three separate defects in it: a dropped crash prompt, a "Wait" that either repeated instantly
 * or never re-offered, and hang state surviving a reload so the re-check fired over a healthy
 * renderer. All three are interleavings rather than single decisions, so this drives the real
 * wiring through a fake window instead of testing the button layout alone.
 */
type EventHandler = (...args: unknown[]) => void;

interface DialogOptions {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

interface FakeWindow {
  emit: (event: string, ...args: unknown[]) => void;
  emitWebContents: (event: string, ...args: unknown[]) => void;
  reload: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function createFakeWindow(): FakeWindow {
  const windowHandlers: Record<string, EventHandler[]> = {};
  const contentsHandlers: Record<string, EventHandler[]> = {};
  const add = (map: Record<string, EventHandler[]>, event: string, handler: EventHandler) => {
    map[event] = [...(map[event] ?? []), handler];
  };

  const reload = vi.fn();
  const close = vi.fn();
  const destroy = vi.fn();

  const win = {
    on: (event: string, handler: EventHandler) => add(windowHandlers, event, handler),
    webContents: {
      on: (event: string, handler: EventHandler) => add(contentsHandlers, event, handler),
    },
    isDestroyed: () => false,
    reload,
    close,
    destroy,
  };

  // The fake implements only the surface setupWindowFailureRecovery touches; Electron's real
  // BrowserWindow cannot be constructed in a unit test.
  const asBrowserWindow = win as unknown as BrowserWindow;
  setupWindowFailureRecovery(asBrowserWindow);

  return {
    emit: (event, ...args) => {
      for (const handler of windowHandlers[event] ?? []) handler(...args);
    },
    emitWebContents: (event, ...args) => {
      for (const handler of contentsHandlers[event] ?? []) handler(...args);
    },
    reload,
    close,
    destroy,
  };
}

/** Answer every dialog with the button at `index`. */
function answerWith(index: number): void {
  showMessageBox.mockResolvedValue({ response: index, checkboxChecked: false });
}

// The mock records exactly the options the code passed, so naming that shape once keeps these
// reads honest rather than asserting a different shape at each call site.
function dialogOptions(): DialogOptions[] {
  return showMessageBox.mock.calls.map((call) => call[1] as DialogOptions);
}

beforeEach(() => {
  vi.useFakeTimers();
  showMessageBox.mockReset();
  answerWith(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("setupWindowFailureRecovery", () => {
  it("offers Wait, Reload and Close while the renderer may still recover", async () => {
    const win = createFakeWindow();
    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);

    expect(dialogOptions()).toHaveLength(1);
    expect(dialogOptions()[0].buttons).toEqual(["Wait", "Reload", "Close"]);
  });

  it("re-offers recovery if the window is still hung after Wait", async () => {
    const win = createFakeWindow();
    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);
    expect(dialogOptions()).toHaveLength(1);

    // `unresponsive` fires once per episode, so without a re-check a permanently hung window
    // would never be offered a way out again.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dialogOptions()).toHaveLength(2);
  });

  it("stops re-offering once the renderer responds again", async () => {
    const win = createFakeWindow();
    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);
    win.emit("responsive");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(dialogOptions()).toHaveLength(1);
  });

  it("does not repeat an identical hang prompt when Wait is chosen", async () => {
    const win = createFakeWindow();
    win.emit("unresponsive");
    // A second hang event lands while the dialog is open, then the user chooses Wait.
    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);

    expect(dialogOptions()).toHaveLength(1);
  });

  it("supersedes an open hang dialog with the crash that followed it", async () => {
    const win = createFakeWindow();
    win.emit("unresponsive");
    win.emitWebContents("render-process-gone", {}, { reason: "crashed" });
    await vi.advanceTimersByTimeAsync(0);

    expect(dialogOptions().map((options) => options.message)).toEqual([
      "This window is not responding",
      "This window has crashed",
    ]);
  });

  it("does not warn about a hang after Reload replaced the renderer", async () => {
    answerWith(1);
    const win = createFakeWindow();

    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);
    win.emitWebContents("render-process-gone", {}, { reason: "crashed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.reload).toHaveBeenCalled();

    const shownBefore = dialogOptions().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dialogOptions()).toHaveLength(shownBefore);
  });

  it("forgets the hang once a fresh load completes", async () => {
    const win = createFakeWindow();
    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);
    win.emitWebContents("did-finish-load");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(dialogOptions()).toHaveLength(1);
  });

  it("ignores a clean renderer exit", async () => {
    const win = createFakeWindow();
    win.emitWebContents("render-process-gone", {}, { reason: "clean-exit" });
    await vi.advanceTimersByTimeAsync(0);

    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it("closes through close() so the state flush runs, then forces teardown", async () => {
    answerWith(2);
    const win = createFakeWindow();

    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();

    // A hung renderer can swallow the close, so teardown is forced after the grace period.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("swallows the rejection when the window disappears under an open dialog", async () => {
    showMessageBox.mockRejectedValue(new Error("Object has been destroyed"));
    const win = createFakeWindow();

    win.emit("unresponsive");
    // Vitest fails a test on an unhandled rejection, so reaching the assertions is the assertion:
    // the dialog was attempted, the rejection was swallowed, and no recovery action ran.
    await vi.advanceTimersByTimeAsync(0);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(win.reload).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });
});
