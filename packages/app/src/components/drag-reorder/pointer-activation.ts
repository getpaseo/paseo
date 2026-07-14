export interface PointerActivationConstraint {
  distance: number;
}

export interface PointerActivationConfig {
  defaultDistance: number;
  handleDistance: number;
}

export function getPointerActivationConstraint(
  useDragHandle: boolean,
  config: PointerActivationConfig,
): PointerActivationConstraint {
  return { distance: useDragHandle ? config.handleDistance : config.defaultDistance };
}
