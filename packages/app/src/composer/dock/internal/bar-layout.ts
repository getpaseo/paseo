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
  /** Null until native geometry arrives; zero is a valid measured clearance. */
  restingClearance: number | null;
  safeAreaBottom: number;
  contentSpacing: number;
  keyboardProgress: number;
  keyboardHeight: number;
}): number {
  "worklet";
  // Rotation can report progress=1 with no keyboard; it must not open the gutter.
  const progress = Math.abs(input.keyboardHeight) > 0 ? input.keyboardProgress : 0;
  return (
    Math.max(input.restingClearance ?? input.safeAreaBottom, input.contentSpacing) *
      (1 - progress) +
    (input.safeAreaBottom + input.contentSpacing) * progress
  );
}
