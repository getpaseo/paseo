export interface NativeDrop<T> {
  data: T[];
  from: number;
  to: number;
}

/**
 * The key of the item a native drop moved, or null when the item was released in the slot it
 * started in. The native list reports every release; web reports only drops that moved an item.
 */
export function movedItemKey<T>(
  { data, from, to }: NativeDrop<T>,
  keyExtractor: (item: T, index: number) => string,
): string | null {
  if (from === to) return null;
  return keyExtractor(data[to], to);
}
