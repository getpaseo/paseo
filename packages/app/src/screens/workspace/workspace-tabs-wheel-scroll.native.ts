import { useRef, type RefObject } from "react";
import type { ScrollView } from "react-native";

export * from "./workspace-tabs-wheel-scroll-core";

/** Native tab strips already expose platform scrolling; no wheel listener is needed. */
export function useWorkspaceTabsWheelScroll(_enabled: boolean): RefObject<ScrollView | null> {
  return useRef<ScrollView>(null);
}
