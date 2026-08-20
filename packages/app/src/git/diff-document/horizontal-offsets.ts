export type DiffHorizontalOffsets = Record<string, number>;

export function horizontalOffsetForPath(
  offsets: Readonly<DiffHorizontalOffsets>,
  path: string,
): number {
  "worklet";
  const offset = offsets[path];
  return typeof offset === "number" ? offset : 0;
}

export function retainHorizontalOffsetsForPaths(
  offsets: Readonly<DiffHorizontalOffsets>,
  paths: readonly string[],
): DiffHorizontalOffsets {
  const retained: DiffHorizontalOffsets = {};
  for (const path of paths) {
    const offset = offsets[path];
    if (typeof offset === "number") {
      Object.defineProperty(retained, path, {
        configurable: true,
        enumerable: true,
        value: offset,
        writable: true,
      });
    }
  }
  return retained;
}

export function retainHorizontalOffsetMapForPaths(
  offsets: ReadonlyMap<string, number>,
  paths: readonly string[],
): Map<string, number> {
  const retained = retainHorizontalOffsetsForPaths(Object.fromEntries(offsets), paths);
  return new Map(Object.entries(retained));
}
