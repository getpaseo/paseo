import type { RefObject } from "react";
import type { View } from "react-native";
import type { openPlanReview } from "./model";

export interface PlanSourcePointerOptions {
  root: RefObject<View | null>;
  anchor: RefObject<number>;
  model: ReturnType<typeof openPlanReview>;
  disabled: boolean;
  onComplete: () => void;
}

// Native uses the same line actions through PressHighlight, leaving swipes to scrolling.
export function usePlanSourcePointer(_options: PlanSourcePointerOptions) {}
