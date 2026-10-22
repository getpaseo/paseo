export type TabletSidebarSwipe = "left" | "right";

export function resolveTabletSidebarSwipe(input: {
  translationX: number;
  translationY: number;
  velocityX: number;
  width: number;
}): TabletSidebarSwipe | null {
  "worklet";
  const distance = Math.abs(input.translationX);
  if (distance < 32 || distance < Math.abs(input.translationY) * 1.5) return null;
  const threshold = Math.min(120, Math.max(64, input.width * 0.1));
  const directedVelocity = input.velocityX * Math.sign(input.translationX);
  if (distance < threshold && directedVelocity < 500) return null;
  return input.translationX > 0 ? "left" : "right";
}

export type TabletSidebarSwipeAction = "open-left" | "open-right" | "close-left" | "close-right";

export function resolveTabletSidebarSwipeAction(
  side: TabletSidebarSwipe,
  panels: { leftOpen: boolean; rightOpen: boolean },
): TabletSidebarSwipeAction {
  "worklet";
  if (side === "right") return panels.leftOpen ? "close-left" : "open-right";
  return panels.rightOpen ? "close-right" : "open-left";
}
