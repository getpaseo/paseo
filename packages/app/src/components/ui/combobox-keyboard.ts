export function getNextActiveIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
  isDisabled?: (index: number) => boolean;
}): number {
  const { currentIndex, itemCount, key, isDisabled } = args;

  if (itemCount <= 0) return -1;

  const step = key === "ArrowDown" ? 1 : -1;
  let candidate: number;
  if (currentIndex < 0) {
    candidate = key === "ArrowDown" ? 0 : itemCount - 1;
  } else {
    candidate = (currentIndex + step + itemCount) % itemCount;
  }

  for (let visited = 0; visited < itemCount; visited += 1) {
    if (!isDisabled?.(candidate)) {
      return candidate;
    }
    candidate = (candidate + step + itemCount) % itemCount;
  }

  return -1;
}
