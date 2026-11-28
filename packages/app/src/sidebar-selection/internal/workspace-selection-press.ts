import { useCallback } from "react";
import type { GestureResponderEvent } from "react-native";
import { readPressModifiers } from "@/keyboard";
import { useSidebarSelectionStore } from "./selection-store";

interface WorkspaceSelectionPressInput {
  workspaceKey: string;
  /** The row's normal press: open the workspace. */
  onNavigate: () => void;
  /** The row's normal press-in: start the long-press drag gesture. */
  onPressIn?: (event: GestureResponderEvent) => void;
}

/**
 * Routes a sidebar workspace row press between navigation and select mode, Finder-style:
 * Shift+click selects a range, Cmd+click (Ctrl+click off macOS) toggles one row, and either one
 * enters select mode on the clicked row alone. In select mode every press selects, so touch and
 * mouse users can keep tapping without a modifier.
 *
 * Selecting presses never consult the row's long-press flag. They never arm the long-press
 * gesture, a native long press already cancels the press, and react-native-web gives Ctrl+click
 * no press-in, so a flag left by an earlier scroll or swipe would swallow the click.
 */
export function useWorkspaceSelectionPress({
  workspaceKey,
  onNavigate,
  onPressIn,
}: WorkspaceSelectionPressInput) {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      const modifiers = readPressModifiers(event);
      const store = useSidebarSelectionStore.getState();
      if (!store.active && !modifiers.shift && !modifiers.mod) {
        onNavigate();
        return;
      }
      event.preventDefault?.();
      store.pressWorkspace(workspaceKey, { range: modifiers.shift });
    },
    [onNavigate, workspaceKey],
  );

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      const modifiers = readPressModifiers(event);
      if (modifiers.shift || modifiers.mod) {
        // Keep the browser from extending a text selection or starting a drag on modifier clicks.
        event.preventDefault?.();
        return;
      }
      if (!useSidebarSelectionStore.getState().active) {
        onPressIn?.(event);
      }
    },
    [onPressIn],
  );

  return { onPress: handlePress, onPressIn: handlePressIn };
}
