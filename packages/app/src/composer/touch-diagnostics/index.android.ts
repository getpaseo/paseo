import { useEffect } from "react";
import type { ComposerTouchState } from "./index";
import { Keyboard, type GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { watchdog } from "@/watchdog";

/** Temporary companion to Android TouchDiagnostics. No draft text or identifiers are recorded. */
export function recordComposerCommand(command: "send" | "queue" | "control" | "model"): void {
  watchdog?.record("touch.composer.command", { command });
}

function useRecordedComposerTouches(state: ComposerTouchState) {
  const insets = useSafeAreaInsets();
  const { active, disabled, sendDisabled, focused, fullscreen, voiceOverlay } = state;
  useEffect(() => {
    if (!active) return;
    watchdog?.record("touch.composer.state", {
      disabled: String(disabled),
      sendDisabled: String(sendDisabled),
      focused: String(focused),
      fullscreen: String(fullscreen),
      voiceOverlay: String(voiceOverlay),
    });
  }, [active, disabled, sendDisabled, focused, fullscreen, voiceOverlay]);
  const record = (phase: string, event: GestureResponderEvent) => {
    if (!watchdog) return;
    const touch = event.nativeEvent;
    watchdog.record("touch.composer", {
      phase,
      target: String(touch.target),
      timestamp: String(touch.timestamp),
      x: String(touch.pageX),
      y: String(touch.pageY),
      disabled: String(state.disabled),
      sendDisabled: String(state.sendDisabled),
      focused: String(state.focused),
      fullscreen: String(state.fullscreen),
      voiceOverlay: String(state.voiceOverlay),
      keyboardVisible: String(Keyboard.isVisible()),
      keyboardHeight: String(Keyboard.metrics()?.height),
      safeBottom: String(insets.bottom),
    });
  };
  return watchdog
    ? {
        onStartShouldSetResponderCapture(event: GestureResponderEvent) {
          record("capture", event);
          return false;
        },
        onTouchEnd: (event: GestureResponderEvent) => record("end", event),
        onTouchCancel: (event: GestureResponderEvent) => record("cancel", event),
      }
    : {};
}

function useNoComposerTouches(_state: ComposerTouchState) {
  return {};
}

// Build configuration is fixed for the module lifetime. Ordinary builds subscribe to nothing.
export const useComposerTouchDiagnostics = watchdog
  ? useRecordedComposerTouches
  : useNoComposerTouches;
