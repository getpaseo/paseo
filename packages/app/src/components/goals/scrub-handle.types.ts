import type { ReactNode } from "react";
import type {
  AccessibilityActionEvent,
  AccessibilityActionInfo,
  StyleProp,
  ViewStyle,
} from "react-native";

export interface ScrubHandleProps {
  disabled: boolean;
  /** A drag began. */
  onScrubStart: () => void;
  /** `deltaPx` is the horizontal travel since the drag began; `fine` is Shift on web. */
  onScrubMove: (deltaPx: number, fine: boolean) => void;
  /** The drag ended or was cancelled. */
  onScrubEnd: () => void;
  accessibilityLabel: string;
  accessibilityHint: string;
  accessibilityValueText: string;
  /** `increment` and `decrement`, with spoken labels. */
  accessibilityActions: AccessibilityActionInfo[];
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
  testID?: string;
}

/** Sideways travel before a touch drag starts, and vertical travel that hands it to the scroll view. */
export const SCRUB_ACTIVE_OFFSET_X = 6;
export const SCRUB_FAIL_OFFSET_Y = 12;
