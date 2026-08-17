import { useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

export const FOOTER_HEIGHT = 75;

// Shared header inner height (excluding safe area insets and border)
// Used by both agent header (ScreenHeader) and explorer sidebar header
// This ensures both headers have the same visual height
export const HEADER_INNER_HEIGHT = 48;
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

// Where the macOS traffic lights sit, and the line anything beside them aligns to.
//
// CENTER_Y is one line for every mode. The buttons are window furniture: they hold the position
// a macOS user aims at whatever the app draws behind them. Two rows can own the top-left corner
// and they disagree, because the header row centers its content at 24 and the shorter tab strip
// that focus mode puts in its place centers its own at 18. One line has to serve both, so it
// sits between them, a little high for the header row and a little low for the tab strip.
//
// BASE_TOP mirrors MAC_TRAFFIC_LIGHT_POSITION in packages/desktop/src/window/window-manager.ts,
// where the shell pins the buttons before the renderer is up. Keeping the two equal makes
// OFFSET_Y come out at 0, so the buttons are already in place at startup and the renderer's
// update moves nothing. Change one without the other and they visibly jump as the app loads.
//
// BUTTON_HEIGHT is the vertical measure, and the buttons are wider than they are tall. Electron
// exposes no API for it, so it is measured from a build. The macOS 26 SDK makes them bigger:
// raise it when Electron rebuilds against that SDK, or they drift off the line.
export const DESKTOP_TRAFFIC_LIGHT_BASE_TOP = 13;
export const DESKTOP_TRAFFIC_LIGHT_BUTTON_HEIGHT = 14;
export const DESKTOP_TRAFFIC_LIGHT_CENTER_Y = 20;
export const DESKTOP_TRAFFIC_LIGHT_OFFSET_Y =
  DESKTOP_TRAFFIC_LIGHT_CENTER_Y -
  DESKTOP_TRAFFIC_LIGHT_BUTTON_HEIGHT / 2 -
  DESKTOP_TRAFFIC_LIGHT_BASE_TOP;

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
  const { rt } = useUnistyles();
  return rt.breakpoint === "xs" || rt.breakpoint === "sm";
}

// SplitContainer relies on dnd-kit and DOM-backed accessibility helpers.
// Keep that capability distinct from desktop-width layout so touch tablets
// can use the desktop shell without entering web-only code paths.
export function supportsDesktopPaneSplits(): boolean {
  return isWeb;
}
