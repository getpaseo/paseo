export type ScrollBehaviorLike = "auto" | "smooth";

const BOTTOM_OVERSCROLL_TOLERANCE_PX = 2;

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
export const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1;

// Fraction of the viewport the target row should sit below the top edge after a jump.
export const SCROLL_TO_MESSAGE_TOP_OFFSET_FRACTION = 0.2;

export function isScrollContainerNearBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  const { scrollTop, clientHeight, scrollHeight } = scrollContainer;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}

export function isScrollContainerAtBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): boolean {
  return isScrollContainerNearBottom(scrollContainer, AUTO_SCROLL_RESUME_THRESHOLD_PX);
}

export function syncNearBottom(
  scrollContainer: HTMLElement | null,
  onNearBottomChange: (value: boolean) => void,
): boolean {
  if (!scrollContainer) {
    onNearBottomChange(true);
    return true;
  }
  const nextValue = isScrollContainerNearBottom(scrollContainer);
  onNearBottomChange(nextValue);
  return nextValue;
}

export function getScrollContainerDistanceFromBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): number {
  return scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
}

export function isScrollContainerOverscrolledPastBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): boolean {
  // Browser zoom can leave scrollTop fractional while the height metrics remain integer-valued.
  return getScrollContainerDistanceFromBottom(scrollContainer) < -BOTTOM_OVERSCROLL_TOLERANCE_PX;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Offset of `element`'s top edge relative to the scroll container's content origin,
// derived from the current scroll position plus the on-screen delta between the two
// bounding boxes. Works regardless of intervening offsetParent chains or transforms.
export function getElementTopWithinScrollContainer(
  scrollContainer: HTMLElement,
  element: HTMLElement,
): number {
  const containerRect = scrollContainer.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return elementRect.top - containerRect.top + scrollContainer.scrollTop;
}

export function scrollContainerToElementTopOffset(
  scrollContainer: HTMLElement,
  element: HTMLElement,
  behavior: ScrollBehaviorLike,
): void {
  const elementTop = getElementTopWithinScrollContainer(scrollContainer, element);
  const target = elementTop - scrollContainer.clientHeight * SCROLL_TO_MESSAGE_TOP_OFFSET_FRACTION;
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  const clampedTop = Math.max(0, Math.min(target, maxScrollTop));
  scrollContainer.scrollTo({ top: clampedTop, behavior });
}
