export type PointerActivationConstraint =
  | { distance: number }
  | { delay: number; tolerance: number };

export interface PointerActivationConfig {
  defaultDistance: number;
  holdDelayMs: number;
  holdTolerance: number;
}

export function getPointerActivationConstraint(
  useDragHandle: boolean,
  config: PointerActivationConfig,
): PointerActivationConstraint {
  if (useDragHandle) {
    return { delay: config.holdDelayMs, tolerance: config.holdTolerance };
  }
  return { distance: config.defaultDistance };
}
