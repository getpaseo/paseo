import { AppState } from "react-native";
import { getDesktopWindow } from "@/desktop/electron/window";
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

/**
 * Electron <webview> / <iframe> guests steal `document.hasFocus()` while the
 * user is still in the Paseo window (Code Server, Browser, etc.). Treat that
 * as focused-in-app so intrusive attention banners don't navigate away.
 */
export function isGuestContentFocused(activeElement: { tagName?: string } | null): boolean {
  if (!activeElement || typeof activeElement.tagName !== "string") {
    return false;
  }
  const tag = activeElement.tagName.toUpperCase();
  return tag === "WEBVIEW" || tag === "IFRAME";
}

function getDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function getElectronOsWindowFocused(): boolean | null {
  const isFocused = getDesktopWindow()?.isFocused;
  if (typeof isFocused !== "function") {
    return null;
  }
  try {
    return Boolean(isFocused());
  } catch {
    return null;
  }
}

function getWindowFocused(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  if (typeof document.hasFocus === "function" && document.hasFocus()) {
    return true;
  }
  // Guest content focused inside our window (Code Server / Browser webview).
  if (isGuestContentFocused(document.activeElement)) {
    return true;
  }
  // Most reliable for Electron: OS BrowserWindow focus (true with webview guests).
  const electronFocused = getElectronOsWindowFocused();
  if (electronFocused !== null) {
    return electronFocused;
  }
  // No hasFocus API — assume focused (SSR / odd environments).
  if (typeof document.hasFocus !== "function") {
    return true;
  }
  return false;
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
