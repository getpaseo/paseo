interface MutedDisclosureState {
  isInteractive: boolean;
  isHovered: boolean;
  isPressed: boolean;
}

/** Thinking/muted rows: show the trailing chevron only while hovered or pressed. */
export function shouldRevealMutedDisclosure(state: MutedDisclosureState): boolean {
  return state.isInteractive && (state.isHovered || state.isPressed);
}
