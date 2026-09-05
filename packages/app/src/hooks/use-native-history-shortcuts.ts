import { useEffect } from "react";
import { AppState } from "react-native";
import { useKeyboardShortcutOverrides } from "./use-keyboard-shortcut-overrides";
import {
  buildNativeHistoryBindings,
  buildNativeHistoryCommands,
} from "@/keyboard/native-history-shortcuts";
import { resolveKeyboardShortcut, type ChordState } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import {
  addNativeHistoryShortcutListener,
  nativeHistoryShortcutsAvailable,
  setNativeHistoryCommands,
} from "@/native/history-shortcuts";
import type { RouteHistoryDirection } from "@/navigation/route-history-state";

export function useNativeHistoryShortcuts(
  enabled: boolean,
  navigate: (direction: RouteHistoryDirection) => boolean,
) {
  const { overrides } = useKeyboardShortcutOverrides();
  useEffect(() => {
    if (!nativeHistoryShortcutsAvailable || !enabled) return;
    const bindings = buildNativeHistoryBindings(overrides);
    let chord: ChordState = { candidateIndices: [], step: 0, timeoutId: null };
    const reset = () => {
      if (chord.timeoutId !== null) clearTimeout(chord.timeoutId);
      chord = { candidateIndices: [], step: 0, timeoutId: null };
      setNativeHistoryCommands(buildNativeHistoryCommands(bindings, chord));
    };
    setNativeHistoryCommands(buildNativeHistoryCommands(bindings, chord));
    const listener = addNativeHistoryShortcutListener((event) => {
      if (
        AppState.currentState !== "active" ||
        useKeyboardShortcutsStore.getState().capturingShortcut
      ) {
        reset();
        return;
      }
      const result = resolveKeyboardShortcut({
        event,
        bindings,
        context: { isMac: true, isDesktop: false, focusScope: "global", commandCenterOpen: false },
        chordState: chord,
        onChordReset: reset,
      });
      chord = result.nextChordState;
      setNativeHistoryCommands(buildNativeHistoryCommands(bindings, chord));
      if (result.match?.action === "navigation.history.back") navigate("back");
      if (result.match?.action === "navigation.history.forward") navigate("forward");
    });
    const appState = AppState.addEventListener("change", reset);
    return () => {
      reset();
      listener.remove();
      appState.remove();
      setNativeHistoryCommands([]);
    };
  }, [enabled, navigate, overrides]);
}
