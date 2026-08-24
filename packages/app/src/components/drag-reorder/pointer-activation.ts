export type PointerActivationConstraint =
  | { distance: number }
  | { delay: number; tolerance: number };

export interface DragActivationConfig {
  movementDistance: number;
  touchHoldDelayMs: number;
  touchHoldTolerance: number;
}

export interface DragActivationConstraints {
  mouse: PointerActivationConstraint;
  touch: PointerActivationConstraint;
}

export function getDragActivationConstraints(
  useDragHandle: boolean,
  config: DragActivationConfig,
): DragActivationConstraints {
  const movement = { distance: config.movementDistance };
  const touch = useDragHandle
    ? { delay: config.touchHoldDelayMs, tolerance: config.touchHoldTolerance }
    : movement;

  return { mouse: movement, touch };
}
