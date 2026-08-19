import { useWindowDimensions } from "react-native";
import { isWeb } from "@/constants/platform";
import { APP_BREAKPOINTS } from "@/styles/unistyles";

export const FOOTER_HEIGHT = 75;

// Shared header inner height (excluding safe area insets and border)
// Used by both agent header (ScreenHeader) and explorer sidebar header
// This ensures both headers have the same visual height
export const HEADER_INNER_HEIGHT = 36;
export const HEADER_INNER_HEIGHT_MOBILE = 56;
export const WORKSPACE_SECONDARY_HEADER_HEIGHT = 36;
export const HEADER_TOP_PADDING_MOBILE = 8;

// Max width for chat content (stream view, input area, new agent form)
export const MAX_CONTENT_WIDTH = 820;
export const COMPACT_FORM_FACTOR_WIDTH = 500;

// Settings uses the canonical desktop list + detail layout. Its sidebar and
// detail target must fit together before it can share width with app navigation.
export const SETTINGS_DESKTOP_SIDEBAR_WIDTH = 320;
export const SETTINGS_DESKTOP_DETAIL_MIN_WIDTH = 400;
export const SETTINGS_DESKTOP_SPLIT_MIN_WIDTH =
  SETTINGS_DESKTOP_SIDEBAR_WIDTH + SETTINGS_DESKTOP_DETAIL_MIN_WIDTH;

// Desktop app constants for macOS traffic light buttons
// These buttons (close/minimize/maximize) overlay the top-left corner
export const DESKTOP_TRAFFIC_LIGHT_WIDTH = 78;
export const DESKTOP_TRAFFIC_LIGHT_HEIGHT = 45;

// Windows/Linux window controls (minimize/maximize/close) — top-right
export const DESKTOP_WINDOW_CONTROLS_WIDTH = 140;
export const DESKTOP_WINDOW_CONTROLS_HEIGHT = 48;

export {
  getIsElectron as getIsElectronRuntime,
  getIsElectronMac as getIsElectronRuntimeMac,
} from "./platform";

/**
 * Reactive hook — re-renders the component when the breakpoint changes.
 * Always use this instead of reading UnistylesRuntime.breakpoint directly.
 */
export function useIsCompactFormFactor(): boolean {
  // Read the width through RN's useWindowDimensions rather than the
  // Unistyles breakpoint: on Android the Unistyles mini-runtime only
  // refreshes its screen dimensions on an ACTION_CONFIGURATION_CHANGED
  // broadcast, which Android does not send while a split-screen or free-form
  // window is being resized — and a stale breakpoint from a small start size
  // would keep the layout compact forever. RN's dimensions update through
  // onGlobalLayout, which fires continuously during those resizes, so the
  // width is always current. The threshold is the md breakpoint.
  const { width } = useWindowDimensions();
  return width < APP_BREAKPOINTS.md;
}

// SplitContainer relies on dnd-kit and DOM-backed accessibility helpers.
// Keep that capability distinct from desktop-width layout so touch tablets
// can use the desktop shell without entering web-only code paths.
export function supportsDesktopPaneSplits(): boolean {
  return isWeb;
}
