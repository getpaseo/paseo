export interface HistoryStartSettleScheduler {
  schedule(): void;
  cancel(): void;
}

export function createHistoryStartSettleScheduler(input: {
  settleFrames: number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  isSettling: () => boolean;
  isLoading: () => boolean;
  onSettle: () => void;
}): HistoryStartSettleScheduler {
  let frameId: number | null = null;
  let remainingFrames = 0;

  const tick = () => {
    if (!input.isSettling()) {
      frameId = null;
      remainingFrames = 0;
      return;
    }
    if (input.isLoading() || remainingFrames > 0) {
      if (!input.isLoading()) {
        remainingFrames -= 1;
      }
      frameId = input.requestFrame(tick);
      return;
    }
    frameId = null;
    input.onSettle();
  };

  return {
    schedule() {
      if (frameId !== null) {
        return;
      }
      remainingFrames = input.settleFrames;
      frameId = input.requestFrame(tick);
    },
    cancel() {
      if (frameId !== null) {
        input.cancelFrame(frameId);
      }
      frameId = null;
      remainingFrames = 0;
    },
  };
}
