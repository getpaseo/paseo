import { computeResizeHandleSizes } from "@/components/resize-handle-sizes";

interface StartResizeHandleDragInput {
  sizes: number[];
  index: number;
  preview: (sizes: number[]) => void;
  commit: (sizes: number[]) => void;
}

export type ResizeHandleInteraction = "web-pointer" | "native-pointer" | "touch";

/**
 * Selects how the resize bar is hit-tested and dragged: thin pointer bar with DOM events on web,
 * thin pointer bar with gesture pan on GPUI, and a wide touch target with a grip pill otherwise.
 */
export function resolveResizeHandleInteraction({
  finePointer,
  isWeb,
}: {
  finePointer: boolean;
  isWeb: boolean;
}): ResizeHandleInteraction {
  if (!finePointer) return "touch";
  return isWeb ? "web-pointer" : "native-pointer";
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
