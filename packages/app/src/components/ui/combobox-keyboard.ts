export function getNextActiveIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
}): number {
  const { currentIndex, itemCount, key } = args;

  if (itemCount <= 0) return -1;

  if (currentIndex < 0) {
    return key === "ArrowDown" ? 0 : itemCount - 1;
  }

  const normalizedCurrent = currentIndex % itemCount;
  return key === "ArrowDown"
    ? (normalizedCurrent + 1) % itemCount
    : (normalizedCurrent - 1 + itemCount) % itemCount;
}

