interface PromptJumpScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface PromptJumpSettleViewport {
  findTargetTop(itemId: string): number | null;
  getContainerTop(): number;
  getScrollMetrics(): PromptJumpScrollMetrics;
  setScrollTop(scrollTop: number): void;
  subscribeToUserIntent(listener: () => void): () => void;
}

export interface PromptJumpSettleController {
  start(itemId: string): void;
  cancel(): void;
  isActive(): boolean;
}

const POSITION_TOLERANCE_PX = 1;
const REQUIRED_STABLE_FRAMES = 2;
const FRAME_BUDGET = 24;
export const PROMPT_JUMP_TOP_INSET_PX = 8;

function distanceFromLandingPosition(targetTop: number, containerTop: number): number {
  return targetTop - containerTop - PROMPT_JUMP_TOP_INSET_PX;
}

export function createPromptJumpSettleController(input: {
  viewport: PromptJumpSettleViewport;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
}): PromptJumpSettleController {
  let activeItemId: string | null = null;
  let frameId: number | null = null;
  let sampledFrames = 0;
  let stableFrames = 0;
  let unsubscribeFromUserIntent: (() => void) | null = null;

  function finish(): void {
    if (frameId !== null) input.cancelFrame(frameId);
    unsubscribeFromUserIntent?.();
    activeItemId = null;
    frameId = null;
    sampledFrames = 0;
    stableFrames = 0;
    unsubscribeFromUserIntent = null;
  }

  function scheduleNextFrame(): void {
    frameId = input.requestFrame(tick);
  }

  function tick(): void {
    frameId = null;
    const itemId = activeItemId;
    if (itemId === null) return;

    sampledFrames += 1;
    const targetTop = input.viewport.findTargetTop(itemId);
    if (targetTop !== null) {
      const delta = distanceFromLandingPosition(targetTop, input.viewport.getContainerTop());
      if (Math.abs(delta) <= POSITION_TOLERANCE_PX) {
        stableFrames += 1;
        if (stableFrames >= REQUIRED_STABLE_FRAMES) {
          finish();
          return;
        }
      } else {
        stableFrames = 0;
        const before = input.viewport.getScrollMetrics();
        input.viewport.setScrollTop(before.scrollTop + delta);
        const after = input.viewport.getScrollMetrics();
        const adjustedTargetTop = input.viewport.findTargetTop(itemId);
        let remainingDelta = 0;
        if (adjustedTargetTop !== null) {
          remainingDelta = distanceFromLandingPosition(
            adjustedTargetTop,
            input.viewport.getContainerTop(),
          );
        }
        const maxScrollTop = Math.max(0, after.scrollHeight - after.clientHeight);
        const isClampedAtBottom = after.scrollTop >= maxScrollTop - POSITION_TOLERANCE_PX;
        if (remainingDelta > POSITION_TOLERANCE_PX && isClampedAtBottom) {
          finish();
          return;
        }
      }
    }

    if (sampledFrames >= FRAME_BUDGET) {
      finish();
      return;
    }
    scheduleNextFrame();
  }

  return {
    start(itemId) {
      finish();
      activeItemId = itemId;
      unsubscribeFromUserIntent = input.viewport.subscribeToUserIntent(finish);
      scheduleNextFrame();
    },
    cancel: finish,
    isActive() {
      return activeItemId !== null;
    },
  };
}
