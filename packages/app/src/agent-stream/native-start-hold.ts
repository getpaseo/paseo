/**
 * Keeps the native list at its start after an "open at start" jump until it stays there.
 *
 * Right after the jump the list can still move itself: LegendList finishes placing the agent's
 * rows and native content-position keeping corrects for rows measured above the viewport. On iOS
 * that moved the list back down by the floating header's height a frame or two after the jump,
 * without any layout callback in JS, leaving the first prompt under the header. The hold checks the
 * offset every frame and returns to the top whenever it has moved, then releases once the list
 * has stayed at the top for `quietFrames` frames, or as soon as the reader drags.
 */
export interface NativeStartHold {
  isHolding(): boolean;
  hold(): void;
  cancel(): void;
}

export function createNativeStartHold(input: {
  quietFrames: number;
  /** Upper bound on frames the hold may run, so a list that never settles is let go. */
  maxFrames: number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  readOffset: () => number;
  scrollToStart: () => void;
  onHoldingChange?: (holding: boolean) => void;
}): NativeStartHold {
  let holding = false;
  let frameId: number | null = null;
  let quietFramesLeft = 0;
  let framesLeft = 0;

  const setHolding = (next: boolean) => {
    if (holding === next) return;
    holding = next;
    input.onHoldingChange?.(next);
  };

  const stop = () => {
    if (frameId !== null) {
      input.cancelFrame(frameId);
      frameId = null;
    }
    setHolding(false);
  };

  const tick = () => {
    frameId = null;
    framesLeft -= 1;
    if (input.readOffset() > 0.5) {
      input.scrollToStart();
      quietFramesLeft = input.quietFrames;
    } else {
      quietFramesLeft -= 1;
    }
    if (quietFramesLeft <= 0 || framesLeft <= 0) {
      stop();
      return;
    }
    frameId = input.requestFrame(tick);
  };

  return {
    isHolding: () => holding,
    hold() {
      if (frameId !== null) input.cancelFrame(frameId);
      setHolding(true);
      input.scrollToStart();
      quietFramesLeft = input.quietFrames;
      framesLeft = input.maxFrames;
      frameId = input.requestFrame(tick);
    },
    cancel: stop,
  };
}
