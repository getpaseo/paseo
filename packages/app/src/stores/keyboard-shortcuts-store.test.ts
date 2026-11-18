import { beforeEach, describe, expect, it } from "vitest";
import { useKeyboardShortcutsStore } from "./keyboard-shortcuts-store";

beforeEach(() => {
  useKeyboardShortcutsStore.setState({
    commandCenterOpen: false,
    commandCenterTab: "all",
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

  it("opens the command center on a tab and returns to All when closed", () => {
    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true, "files");
    expect(useKeyboardShortcutsStore.getState()).toMatchObject({
      commandCenterOpen: true,
      commandCenterTab: "files",
    });

    useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
    expect(useKeyboardShortcutsStore.getState()).toMatchObject({
      commandCenterOpen: false,
      commandCenterTab: "all",
    });

    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true);
    expect(useKeyboardShortcutsStore.getState().commandCenterTab).toBe("all");
  });

  it("toggles shortcut capture state", () => {
    expect(useKeyboardShortcutsStore.getState().capturingShortcut).toBe(false);
    useKeyboardShortcutsStore.getState().setCapturingShortcut(true);
    expect(useKeyboardShortcutsStore.getState().capturingShortcut).toBe(true);
  });
});
