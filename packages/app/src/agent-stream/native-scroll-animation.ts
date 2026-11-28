export function shouldAnimateNativeScrollToBottom(input: {
  distanceFromEnd: number;
  viewportHeight: number;
  drawDistance: number;
}): boolean {
  // Scrolled away from the end, LegendList keeps half its draw distance mounted below the
  // viewport. An animated jump farther than that crosses rows it has not rendered.
  const mountedBelowViewport = input.drawDistance / 2;
  return input.viewportHeight > 0 && input.distanceFromEnd <= mountedBelowViewport;
}
