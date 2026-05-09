import { beforeEach, describe, expect, it } from "vitest";
import { useKeyboardShortcutsStore } from "./keyboard-shortcuts-store";

beforeEach(() => {
  useKeyboardShortcutsStore.setState({
    commandCenterOpen: false,
    projectPickerOpen: false,
    projectPickerIntent: { kind: "open-project" },
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

  it("toggles shortcut capture state", () => {
    expect(useKeyboardShortcutsStore.getState().capturingShortcut).toBe(false);
    useKeyboardShortcutsStore.getState().setCapturingShortcut(true);
    expect(useKeyboardShortcutsStore.getState().capturingShortcut).toBe(true);
  });

  it("stores and resets the project picker intent", () => {
    useKeyboardShortcutsStore
      .getState()
      .setProjectPickerOpen(true, { kind: "new-workspace", headerTitle: "New session" });

    expect(useKeyboardShortcutsStore.getState().projectPickerOpen).toBe(true);
    expect(useKeyboardShortcutsStore.getState().projectPickerIntent).toEqual({
      kind: "new-workspace",
      headerTitle: "New session",
    });

    useKeyboardShortcutsStore.getState().setProjectPickerOpen(false);

    expect(useKeyboardShortcutsStore.getState().projectPickerOpen).toBe(false);
    expect(useKeyboardShortcutsStore.getState().projectPickerIntent).toEqual({
      kind: "open-project",
    });
  });
});
