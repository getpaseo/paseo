import type { LeftSidebarPresentation, MobilePanelView } from "@/stores/panel-store";

export interface WorkspaceRowPress {
  cancelled: boolean;
  native: boolean;
  selected: boolean;
  sidebar: LeftSidebarPresentation;
  target: MobilePanelView;
  acknowledge(): void;
  navigate(): void;
}

export function acceptWorkspaceRowPress(press: WorkspaceRowPress): boolean {
  if (press.cancelled) return false;
  if (press.native && press.sidebar !== "dock" && press.target !== "agent-list") return false;
  // A selected docked row neither changes selection nor leaves the screen to clear the fill.
  if (!press.selected || press.sidebar !== "dock") press.acknowledge();
  press.navigate();
  return true;
}
