import { AppState } from "react-native";
import { isNative } from "@/constants/platform";

interface AppVisibilityInput {
  appState: string;
  native: boolean;
  documentVisible: boolean;
}

interface ActiveAppVisibilityInput extends AppVisibilityInput {
  windowFocused: boolean;
}

export function isAppVisible(input: AppVisibilityInput): boolean {
  return input.appState === "active" && (input.native || input.documentVisible);
}

export function isAppActivelyVisible(input: ActiveAppVisibilityInput): boolean {
  return isAppVisible(input) && (input.native || input.windowFocused);
}

function getDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function getWindowFocused(): boolean {
  return (
    typeof document === "undefined" ||
    typeof document.hasFocus !== "function" ||
    document.hasFocus()
  );
}

export function getIsAppVisible(appState: string = AppState.currentState): boolean {
  return isAppVisible({
    appState,
    native: isNative,
    documentVisible: getDocumentVisible(),
  });
}

export function getIsAppActivelyVisible(appState: string = AppState.currentState): boolean {
  return isAppActivelyVisible({
    appState,
    native: isNative,
    documentVisible: getDocumentVisible(),
    windowFocused: getWindowFocused(),
  });
}
