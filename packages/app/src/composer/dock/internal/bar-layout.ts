import { createContext } from "react";

// The dock measures the bordered surface independently of queues and outer gutters.
export const ComposerBarLayoutContext = createContext<{
  onSurfaceHeightChange: (height: number) => void;
  ownsBottomGutter: boolean;
  /** Modern native content slot allocation, before the composer's outer gutters. */
  containerWidth?: number;
  /** Bordered input surface allocation, after outer gutters and the content-width cap. */
  surfaceWidth?: number;
} | null>(null);

export function resolveComposerBottomPadding(input: {
  restingClearance: number;
  safeAreaBottom: number;
  contentSpacing: number;
  keyboardProgress: number;
}): number {
  "worklet";
  return (
    Math.max(input.restingClearance, input.contentSpacing) * (1 - input.keyboardProgress) +
    (input.safeAreaBottom + input.contentSpacing) * input.keyboardProgress
  );
}
