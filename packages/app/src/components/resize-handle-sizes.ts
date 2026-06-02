import { MIN_SPLIT_SIZE } from "@/stores/workspace-layout-constants";

interface ComputeResizeHandleSizesInput {
  sizes: number[];
  index: number;
  deltaRatio: number;
  minSize?: number;
}

export function computeResizeHandleSizes({
  sizes,
  index,
  deltaRatio,
  minSize = MIN_SPLIT_SIZE,
}: ComputeResizeHandleSizesInput): number[] {
  const nextSizes = sizes.slice();
  const leftSize = sizes[index];
  const rightSize = sizes[index + 1];
  if (leftSize === undefined || rightSize === undefined) {
    return nextSizes;
  }

  const pairSize = leftSize + rightSize;
  if (pairSize <= 0) {
    return nextSizes;
  }

  const adjacentMinSize = Math.min(minSize, pairSize / 2);
  const nextLeftSize = Math.min(
    pairSize - adjacentMinSize,
    Math.max(adjacentMinSize, leftSize + deltaRatio),
  );
  nextSizes[index] = nextLeftSize;
  nextSizes[index + 1] = pairSize - nextLeftSize;
  return nextSizes;
}
