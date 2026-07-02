import { useKeyboardState } from "react-native-keyboard-controller";

export function useSoftKeyboardVisible(): boolean {
  return useKeyboardState((state) => state.isVisible);
}
