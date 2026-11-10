import { useContext } from "react";
import { useSafeAreaFrame } from "react-native-safe-area-context";
import { AppWindowFrameContext } from "./app-window-frame-context";

// Once the native probe is ready, frame, insets and system-control geometry share one event.
export function useAppWindowSize() {
  const safeAreaFrame = useSafeAreaFrame();
  return useContext(AppWindowFrameContext) ?? safeAreaFrame;
}
