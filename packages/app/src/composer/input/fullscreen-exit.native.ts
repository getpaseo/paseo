import { useEffect } from "react";
import { BackHandler } from "react-native";

/** The hardware back button leaves fullscreen instead of the screen. */
export function useComposerFullscreenExit(
  active: boolean,
  onExit: () => void,
): ((node: unknown) => void) | undefined {
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onExit();
      return true;
    });
    return () => subscription.remove();
  }, [active, onExit]);
  return undefined;
}
