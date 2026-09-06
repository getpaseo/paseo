import { computeResizeHandleSizes } from "@/components/resize-handle-sizes";

interface StartResizeHandleDragInput {
  sizes: number[];
  index: number;
  preview: (sizes: number[]) => void;
  commit: (sizes: number[]) => void;
  frameScheduler?: ResizeHandleDragFrameScheduler;
}

interface ResizeHandleDragFrameScheduler {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
}

export interface ResizeHandleDrag {
  move: (deltaRatio: number) => void;
  finish: () => void;
}

const defaultFrameScheduler: ResizeHandleDragFrameScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frameId) => cancelAnimationFrame(frameId),
};

export function startResizeHandleDrag({
  sizes,
  index,
  preview,
  commit,
  frameScheduler = defaultFrameScheduler,
}: StartResizeHandleDragInput): ResizeHandleDrag {
  let pendingSizes: number[] | null = null;
  let previewFrameId: number | null = null;

  return {
    move(deltaRatio) {
      pendingSizes = computeResizeHandleSizes({ sizes, index, deltaRatio });
      if (previewFrameId !== null) {
        return;
      }
      const frameId = frameScheduler.requestFrame(() => {
        if (previewFrameId !== frameId) {
          return;
        }
        previewFrameId = null;
        if (pendingSizes) {
          preview(pendingSizes);
        }
      });
      previewFrameId = frameId;
    },
    finish() {
      if (pendingSizes) {
        if (previewFrameId !== null) {
          frameScheduler.cancelFrame(previewFrameId);
          previewFrameId = null;
          preview(pendingSizes);
        }
        commit(pendingSizes);
        pendingSizes = null;
      }
    },
  };
}
