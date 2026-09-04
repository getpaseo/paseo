import { computeResizeHandleSizes } from "@/components/resize-handle-sizes";

interface StartResizeHandleDragInput {
  sizes: number[];
  index: number;
  preview: (sizes: number[]) => void;
  commit: (sizes: number[]) => void;
}

export interface ResizeHandleDrag {
  move: (deltaRatio: number) => void;
  finish: () => void;
}

export function startResizeHandleDrag({
  sizes,
  index,
  preview,
  commit,
}: StartResizeHandleDragInput): ResizeHandleDrag {
  let pendingSizes: number[] | null = null;

  return {
    move(deltaRatio) {
      pendingSizes = computeResizeHandleSizes({ sizes, index, deltaRatio });
      preview(pendingSizes);
    },
    finish() {
      if (pendingSizes) {
        commit(pendingSizes);
        pendingSizes = null;
      }
    },
  };
}
