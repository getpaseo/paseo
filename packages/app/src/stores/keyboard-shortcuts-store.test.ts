import { beforeEach, describe, expect, it } from "vitest";
import { useKeyboardShortcutsStore } from "./keyboard-shortcuts-store";

beforeEach(() => {
  useKeyboardShortcutsStore.setState({
    commandCenterOpen: false,
    commandCenterScope: null,
    shortcutsDialogOpen: false,
    capturingShortcut: false,
    altDown: false,
    cmdOrCtrlDown: false,
    sidebarShortcutWorkspaceTargets: [],
  });
});

describe("keyboard-shortcuts-store", () => {
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
});
