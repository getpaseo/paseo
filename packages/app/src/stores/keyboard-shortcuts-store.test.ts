import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcutsStore } from "./keyboard-shortcuts-store";

describe("keyboard shortcut badge state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useKeyboardShortcutsStore.setState({
      commandCenterOpen: false,
      commandCenterScope: null,
      shortcutsDialogOpen: false,
      capturingShortcut: false,
      altDown: false,
      cmdOrCtrlDown: false,
      controlShortcutModifierDown: false,
      showShortcutBadges: false,
      showControlShortcutBadges: false,
      sidebarShortcutWorkspaceTargets: [],
    });
  });

  afterEach(() => {
    useKeyboardShortcutsStore.getState().resetModifiers();
    vi.useRealTimers();
  });

  it("toggles command center open state", () => {
    expect(useKeyboardShortcutsStore.getState().commandCenterOpen).toBe(false);
    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true);
    expect(useKeyboardShortcutsStore.getState().commandCenterOpen).toBe(true);
  });

  it("opens the command center with a scope and clears it when closed", () => {
    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true, "files");
    expect(useKeyboardShortcutsStore.getState()).toMatchObject({
      commandCenterOpen: true,
      commandCenterScope: "files",
    });

    useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
    expect(useKeyboardShortcutsStore.getState()).toMatchObject({
      commandCenterOpen: false,
      commandCenterScope: null,
    });
  });

  it("toggles shortcut capture state", () => {
    expect(useKeyboardShortcutsStore.getState().capturingShortcut).toBe(false);
    useKeyboardShortcutsStore.getState().setCapturingShortcut(true);
    expect(useKeyboardShortcutsStore.getState().capturingShortcut).toBe(true);
  });

  it("reveals control hints after holding the control shortcut modifier", () => {
    useKeyboardShortcutsStore.getState().setControlShortcutModifierDown(true);

    expect(useKeyboardShortcutsStore.getState().showControlShortcutBadges).toBe(false);
    vi.advanceTimersByTime(150);
    expect(useKeyboardShortcutsStore.getState().showControlShortcutBadges).toBe(true);

    useKeyboardShortcutsStore.getState().setControlShortcutModifierDown(false);
    expect(useKeyboardShortcutsStore.getState().showControlShortcutBadges).toBe(false);
  });

  it("does not reveal sidebar number hints for the browser control shortcut modifier", () => {
    useKeyboardShortcutsStore.getState().setControlShortcutModifierDown(true);
    vi.advanceTimersByTime(150);

    expect(useKeyboardShortcutsStore.getState().showControlShortcutBadges).toBe(true);
    expect(useKeyboardShortcutsStore.getState().showShortcutBadges).toBe(false);
  });

  it("keeps control hints visible when sidebar modifier state is cleared", () => {
    useKeyboardShortcutsStore.getState().setControlShortcutModifierDown(true);
    vi.advanceTimersByTime(150);

    useKeyboardShortcutsStore.getState().setCmdOrCtrlDown(true);
    useKeyboardShortcutsStore.getState().setCmdOrCtrlDown(false);

    expect(useKeyboardShortcutsStore.getState().showControlShortcutBadges).toBe(true);
  });
});
