export function shouldAnimateNativeScrollToBottom(input: {
  offsetY: number;
  viewportHeight: number;
  windowSize: number;
}): boolean {
  // VirtualizedList splits the extra window around the viewport. An animated
  // jump farther than the bottom-side overscan crosses unmounted history.
  const bottomOverscanHeight = ((input.windowSize - 1) / 2) * input.viewportHeight;
  return input.viewportHeight > 0 && input.offsetY <= bottomOverscanHeight;
}
