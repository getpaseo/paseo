/**
 * The rows in the order a native list shows when a drag ends.
 *
 * Sortables' own `data` for `onDragEnd` indexes rows through `keyToIndex`, a derived value that can
 * trail `indexToKey` by a frame. A drop right after a swap would then save the order from before the
 * swap, and a row added or removed during the drop leaves a hole. `indexToKey` is the order on
 * screen. Keys without a row are skipped, and rows without a key are left out, so callers keep
 * their stored place.
 */
export function orderDroppedItems<T>(input: {
  data: readonly T[];
  keyExtractor: (item: T) => string;
  indexToKey: readonly string[];
}): T[] {
  const itemsByKey = new Map(input.data.map((item) => [input.keyExtractor(item), item]));
  const ordered: T[] = [];
  for (const key of input.indexToKey) {
    const item = itemsByKey.get(key);
    if (item !== undefined) {
      ordered.push(item);
    }
  }
  return ordered;
}
