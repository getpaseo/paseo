/**
 * The native viewport's disclosure hold. While a row is held, it is the only row the list may
 * anchor on. The hold ends once item sizes stop changing for `quietFrames` frames: the list
 * measures the toggled row and any rows it inserted over one or more frames, and end following
 * must not resume between the change and the list's last layout correction.
 */
export interface NativeDisclosureHold {
  heldRowId(): string | null;
  hold(rowId: string): void;
  noteItemSizeChanged(): void;
  cancel(): void;
}

export function createNativeDisclosureHold(input: {
  quietFrames: number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  onRelease: () => void;
}): NativeDisclosureHold {
  let heldRowId: string | null = null;
  let frameId: number | null = null;
  let remainingFrames = 0;

  const stopCountdown = () => {
    if (frameId !== null) {
      input.cancelFrame(frameId);
      frameId = null;
    }
  };

  const tick = () => {
    remainingFrames -= 1;
    if (remainingFrames > 0) {
      frameId = input.requestFrame(tick);
      return;
    }
    frameId = null;
    heldRowId = null;
    input.onRelease();
  };

  const restartCountdown = () => {
    stopCountdown();
    remainingFrames = input.quietFrames;
    frameId = input.requestFrame(tick);
  };

  return {
    heldRowId: () => heldRowId,
    hold(rowId) {
      heldRowId = rowId;
      restartCountdown();
    },
    noteItemSizeChanged() {
      if (heldRowId !== null) {
        restartCountdown();
      }
    },
    cancel() {
      stopCountdown();
      heldRowId = null;
    },
  };
}
