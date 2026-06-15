export type PointerActivationConstraint =
  | { distance: number }
  | { delay: number; tolerance: number };

export interface PointerActivationConfig {
  defaultDistance: number;
  holdDelayMs: number;
  holdTolerance: number;
}

export type PointerActivationMode = "hold" | "distance";

export function getPointerActivationConstraint(
  useDragHandle: boolean,
  config: PointerActivationConfig,
  handleActivationMode: PointerActivationMode = "hold",
): PointerActivationConstraint {
  if (useDragHandle && handleActivationMode === "hold") {
    return { delay: config.holdDelayMs, tolerance: config.holdTolerance };
  }
  return { distance: config.defaultDistance };
}
