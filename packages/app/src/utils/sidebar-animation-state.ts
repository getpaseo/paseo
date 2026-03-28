interface SidebarAnimationSyncInput {
  previousIsOpen: boolean;
  nextIsOpen: boolean;
  previousWindowWidth: number;
  nextWindowWidth: number;
}

interface SidebarAnimationTargetInput {
  isOpen: boolean;
  windowWidth: number;
}

interface SidebarAnimationTargets {
  translateX: number;
  backdropOpacity: number;
}

export function shouldSyncSidebarAnimation(input: SidebarAnimationSyncInput): boolean {
  return (
    input.previousIsOpen !== input.nextIsOpen ||
    input.previousWindowWidth !== input.nextWindowWidth
  );
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
