import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
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
export const COMPACT_FORM_FACTOR_WIDTH = 768;

// Progressive narrowing thresholds for the composer controls row.
// At each level the controls strip down further to fit narrow panes.
// Level 0: full desktop (text badges, all controls inline)
// Level 1: icon-only badges (hide text, collapse features to single button)
// Level 2: minimal (hide features, keep provider + model + thinking)
// Level 3: sheet mode (existing compact layout, threshold = COMPACT_FORM_FACTOR_WIDTH)
export const COMPOSER_COMPACT_LEVEL_1_WIDTH = 560;
export const COMPOSER_COMPACT_LEVEL_2_WIDTH = 400;

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
  const { rt } = useUnistyles();
  return rt.breakpoint === "xs" || rt.breakpoint === "sm";
}

// SplitContainer relies on dnd-kit and DOM-backed accessibility helpers.
// Keep that capability distinct from desktop-width layout so touch tablets
// can use the desktop shell without entering web-only code paths.
export function supportsDesktopPaneSplits(): boolean {
  return isWeb;
}

/**
 * Tracks the progressive compact level for composer controls based on
 * container width. Returns a level 0-2 where higher means more compact.
 *
 * Level 0: full desktop (text badges, all controls inline)
 * Level 1: icon-only badges (hide text, collapse features to single button)
 * Level 2: minimal (hide features, keep provider + model + thinking)
 *
 * The full sheet/compact mode (level 3) is handled separately by
 * useContainerWidthBelow(COMPACT_FORM_FACTOR_WIDTH).
 */
export function useComposerCompactLevel(options?: { initialLevel?: number }): {
  onLayout: (e: LayoutChangeEvent) => void;
  level: number;
} {
  const [level, setLevel] = useState(options?.initialLevel ?? 0);
  return {
    onLayout: useCallback((e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      let next = 0;
      if (w < COMPOSER_COMPACT_LEVEL_2_WIDTH) {
        next = 2;
      } else if (w < COMPOSER_COMPACT_LEVEL_1_WIDTH) {
        next = 1;
      }
      setLevel((prev) => (prev === next ? prev : next));
    }, []),
    level,
  };
}
