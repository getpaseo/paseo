export function shouldAutoFocusWorkspaceDraftComposer(input: {
  isPaneFocused: boolean;
  isSubmitting: boolean;
}): boolean {
  return input.isPaneFocused && !input.isSubmitting;
}
