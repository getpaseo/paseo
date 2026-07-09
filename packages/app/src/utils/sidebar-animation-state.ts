interface SidebarAnimationSyncInput {
  previousIsOpen: boolean;
  nextIsOpen: boolean;
  previousWindowWidth: number;
  nextWindowWidth: number;
}

export type MobileSidebarView = "agent" | "agent-list" | "file-explorer";

interface SidebarAnimationSyncPlanInput extends SidebarAnimationSyncInput {
  previousMobileView: MobileSidebarView;
  nextMobileView: MobileSidebarView;
  ownedMobileView: Exclude<MobileSidebarView, "agent">;
}

interface SidebarAnimationSyncPlan {
  shouldSync: boolean;
  didOpen: boolean;
  didOpenStateChange: boolean;
  ownsMobileViewChange: boolean;
}

interface SidebarAnimationTargetInput {
  isOpen: boolean;
  windowWidth: number;
}

interface SidebarAnimationTargets {
  translateX: number;
  backdropOpacity: number;
}

export const MOBILE_PANEL_STATE_AGENT = 0;
export const MOBILE_PANEL_STATE_AGENT_LIST_OPENING = 1;
export const MOBILE_PANEL_STATE_AGENT_LIST_OPEN = 2;
export const MOBILE_PANEL_STATE_AGENT_LIST_CLOSING = 3;
export const MOBILE_PANEL_STATE_FILE_EXPLORER_OPENING = 4;
export const MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN = 5;
export const MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING = 6;

export const MOBILE_PANEL_TARGET_AGENT = 0;
export const MOBILE_PANEL_TARGET_AGENT_LIST = 1;
export const MOBILE_PANEL_TARGET_FILE_EXPLORER = 2;

const CLOSED_POSITION_TOLERANCE = 1;

export function shouldSyncSidebarAnimation(input: SidebarAnimationSyncInput): boolean {
  return (
    input.previousIsOpen !== input.nextIsOpen || input.previousWindowWidth !== input.nextWindowWidth
  );
}

export function getSidebarAnimationSyncPlan(
  input: SidebarAnimationSyncPlanInput,
): SidebarAnimationSyncPlan {
  const didOpenStateChange = input.previousIsOpen !== input.nextIsOpen;
  const didMobileViewChange = input.previousMobileView !== input.nextMobileView;
  return {
    shouldSync:
      didMobileViewChange ||
      shouldSyncSidebarAnimation({
        previousIsOpen: input.previousIsOpen,
        nextIsOpen: input.nextIsOpen,
        previousWindowWidth: input.previousWindowWidth,
        nextWindowWidth: input.nextWindowWidth,
      }),
    didOpen: !input.previousIsOpen && input.nextIsOpen,
    didOpenStateChange,
    ownsMobileViewChange:
      input.previousMobileView === input.ownedMobileView ||
      input.nextMobileView === input.ownedMobileView,
  };
}

export function getLeftSidebarAnimationTargets(
  input: SidebarAnimationTargetInput,
): SidebarAnimationTargets {
  return {
    translateX: input.isOpen ? 0 : -input.windowWidth,
    backdropOpacity: input.isOpen ? 1 : 0,
  };
}

export function getRightSidebarAnimationTargets(
  input: SidebarAnimationTargetInput,
): SidebarAnimationTargets {
  return {
    translateX: input.isOpen ? 0 : input.windowWidth,
    backdropOpacity: input.isOpen ? 1 : 0,
  };
}

export function canOpenLeftSidebarGesture(
  mobilePanelState: number,
  translateX: number,
  windowWidth: number,
): boolean {
  "worklet";
  return (
    mobilePanelState === MOBILE_PANEL_STATE_AGENT &&
    translateX <= -windowWidth + CLOSED_POSITION_TOLERANCE
  );
}

export function canCloseLeftSidebarGesture(mobilePanelState: number): boolean {
  "worklet";
  return mobilePanelState === MOBILE_PANEL_STATE_AGENT_LIST_OPEN;
}

export function canOpenRightSidebarGesture(
  mobilePanelState: number,
  translateX: number,
  windowWidth: number,
): boolean {
  "worklet";
  return (
    mobilePanelState === MOBILE_PANEL_STATE_AGENT &&
    translateX >= windowWidth - CLOSED_POSITION_TOLERANCE
  );
}

export function canCloseRightSidebarGesture(mobilePanelState: number): boolean {
  "worklet";
  return mobilePanelState === MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN;
}

export function shouldSettleMobilePanelTransition(
  activeTarget: number,
  settledTarget: number,
): boolean {
  "worklet";
  return activeTarget === settledTarget;
}
