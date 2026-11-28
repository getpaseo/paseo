interface InitialDrawDistanceFrames {
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

export function createInitialDrawDistanceExpansion(
  frames: InitialDrawDistanceFrames,
  expand: () => void,
) {
  let frame: number | null = null;
  let eligible = false;
  let scrolling = false;
  let expanded = false;

  function cancel() {
    if (frame === null) return;
    frames.cancelFrame(frame);
    frame = null;
  }

  function scheduleIfIdle() {
    if (!eligible || scrolling || expanded || frame !== null) return;
    frame = frames.requestFrame(() => {
      frame = frames.requestFrame(() => {
        frame = null;
        expanded = true;
        expand();
      });
    });
  }

  return {
    schedule() {
      eligible = true;
      scheduleIfIdle();
      return () => {
        eligible = false;
        cancel();
      };
    },
    pauseForScroll() {
      scrolling = true;
      cancel();
    },
    resumeAfterScroll() {
      scrolling = false;
      scheduleIfIdle();
    },
  };
}
