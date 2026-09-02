import { useKeyboardState } from "react-native-keyboard-controller";

export function useKeyboardVisibility(): boolean {
  return useKeyboardState((state) => state.isVisible);
}
