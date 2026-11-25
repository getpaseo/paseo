import { type RefObject, useCallback } from "react";
import type { GestureResponderEvent } from "react-native";
import { readPressModifiers } from "@/keyboard";
import { useSidebarSelectionStore } from "./selection-store";

interface WorkspaceSelectionPressInput {
  workspaceKey: string;
  /** Set by the row's long-press gesture so the release after a long press does not also select. */
  didLongPressRef?: RefObject<boolean>;
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
 */
export function useWorkspaceSelectionPress({
  workspaceKey,
  didLongPressRef,
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
      if (didLongPressRef?.current) {
        didLongPressRef.current = false;
        return;
      }
      event.preventDefault?.();
      store.pressWorkspace(workspaceKey, { range: modifiers.shift });
    },
    [didLongPressRef, onNavigate, workspaceKey],
  );

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      const modifiers = readPressModifiers(event);
      const isModifierPress = modifiers.shift || modifiers.mod;
      if (!isModifierPress && !useSidebarSelectionStore.getState().active) {
        onPressIn?.(event);
        return;
      }
      // This press never arms the long-press gesture, so a flag left by an earlier scroll, drag, or
      // long press is stale and must not swallow it.
      if (didLongPressRef) {
        didLongPressRef.current = false;
      }
      if (isModifierPress) {
        // Keep the browser from extending a text selection or starting a drag on modifier clicks.
        event.preventDefault?.();
      }
    },
    [didLongPressRef, onPressIn],
  );

  return { onPress: handlePress, onPressIn: handlePressIn };
}
