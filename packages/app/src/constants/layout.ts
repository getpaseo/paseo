import { Platform } from "react-native";

export const FOOTER_HEIGHT = 75;

// Shared header inner height (excluding safe area insets and border)
// Used by both agent header (ScreenHeader) and explorer sidebar header
// This ensures both headers have the same visual height
export const HEADER_INNER_HEIGHT = 48;
export const HEADER_INNER_HEIGHT_MOBILE = 56;

// Max width for chat content (stream view, input area, new agent form)
export const MAX_CONTENT_WIDTH = 820;

// Tauri desktop app constants for macOS traffic light buttons
// These buttons (close/minimize/maximize) overlay the top-left corner
export const TAURI_TRAFFIC_LIGHT_WIDTH = 78;
export const TAURI_TRAFFIC_LIGHT_HEIGHT = 56;

// Check if running in Tauri desktop app on macOS
function isTauriMac(): boolean {
  if (Platform.OS !== "web") return false;
  if (typeof window === "undefined") return false;
  if (!("__TAURI__" in window)) return false;
  // Check for macOS via user agent
  const ua = navigator.userAgent;
  return ua.includes("Mac OS") || ua.includes("Macintosh");
}

// Cached result - only cache true, keep checking if false (in case __TAURI__ loads later)
let _isTauriMacCached: boolean | null = null;

export function getIsTauriMac(): boolean {
  if (_isTauriMacCached === true) {
    return true;
  }
  const result = isTauriMac();
  if (result) {
    _isTauriMacCached = true;
  }
  return result;
}

// Get traffic light padding values (only non-zero on Tauri macOS)
export function getTrafficLightPadding(): { left: number; top: number } {
  if (!getIsTauriMac()) {
    return { left: 0, top: 0 };
  }
  return {
    left: TAURI_TRAFFIC_LIGHT_WIDTH,
    top: TAURI_TRAFFIC_LIGHT_HEIGHT,
  };
}
