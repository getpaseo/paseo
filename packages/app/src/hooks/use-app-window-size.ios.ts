import { useSafeAreaFrame } from "react-native-safe-area-context";

// Frame and insets must come from the same provider event during rotation.
export function useAppWindowSize() {
  return useSafeAreaFrame();
}
