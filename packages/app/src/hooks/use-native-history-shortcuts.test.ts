// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardShortcutInput, ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useNativeHistoryShortcuts } from "./use-native-history-shortcuts";

// Only the native event boundary and persisted preferences are substituted.
// The hook, shortcut store, and chord matcher run together.
const hardware = vi.hoisted(() => ({
  listeners: new Set<(event: KeyboardShortcutInput) => void>(),
  overrides: {
    "navigation-history-back": "Mod+ArrowLeft",
    "navigation-history-forward": "Mod+ArrowRight",
  } as ShortcutOverrides,
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("./use-keyboard-shortcut-overrides", () => ({
  useKeyboardShortcutOverrides: () => ({ overrides: hardware.overrides }),
}));
vi.mock("@/native/history-shortcuts", () => ({
  nativeHistoryShortcutsAvailable: true,
  setNativeHistoryCommands() {},
  addNativeHistoryShortcutListener(listener: (event: KeyboardShortcutInput) => void) {
    hardware.listeners.add(listener);
    return { remove: () => hardware.listeners.delete(listener) };
  },
}));

function press(code: string, metaKey = true) {
  act(() => {
    for (const listener of hardware.listeners) {
      listener({
        key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
        code,
        metaKey,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
      });
    }
  });
}

afterEach(() => {
  cleanup();
  useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
  hardware.overrides = {
    "navigation-history-back": "Mod+ArrowLeft",
    "navigation-history-forward": "Mod+ArrowRight",
  };
});

describe("native history command-center boundary", () => {
  it("blocks both directions while open and resumes after closing without remounting", () => {
    const navigate = vi.fn();
    renderHook(() => useNativeHistoryShortcuts(true, navigate));
    press("ArrowLeft");
    expect(navigate.mock.calls).toEqual([["back"]]);

    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true);
    press("ArrowLeft");
    press("ArrowRight");
    expect(navigate.mock.calls).toEqual([["back"]]);

    useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
    press("ArrowRight");
    expect(navigate.mock.calls).toEqual([["back"], ["forward"]]);
  });

  it("rejects an in-progress history chord when the command center opens", () => {
    hardware.overrides = { "navigation-history-back": "Mod+K ArrowLeft" };
    const navigate = vi.fn();
    renderHook(() => useNativeHistoryShortcuts(true, navigate));
    press("KeyK");
    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true);
    press("ArrowLeft", false);
    expect(navigate).not.toHaveBeenCalled();

    useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
    press("KeyK");
    press("ArrowLeft", false);
    expect(navigate.mock.calls).toEqual([["back"]]);
  });
});
