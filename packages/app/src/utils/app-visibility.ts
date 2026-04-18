import { AppState } from "react-native";
import { isNative } from "@/constants/platform";

export function getIsAppActivelyVisible(appState: string = AppState.currentState): boolean {
  if (appState !== "active") {
    return false;
  }

  if (isNative) {
    return true;
  }

  const documentVisible = typeof document === "undefined" || document.visibilityState === "visible";
  const windowFocused =
    typeof document === "undefined" ||
    typeof document.hasFocus !== "function" ||
    document.hasFocus();

  return documentVisible && windowFocused;
}
