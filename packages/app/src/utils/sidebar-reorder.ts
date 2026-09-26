export function mergeWithRemainder(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key));
  return [...input.reorderedVisibleKeys, ...remainder];
}

export function hasVisibleOrderChanged(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): boolean {
  const visibleSet = new Set(input.reorderedVisibleKeys);
  const currentVisible = input.currentOrder.filter((key) => visibleSet.has(key));
  if (currentVisible.length !== input.reorderedVisibleKeys.length) {
    return true;
  }
  return input.reorderedVisibleKeys.some((key, index) => currentVisible[index] !== key);
}

/**
 * Reorders the visible keys inside `currentOrder` without moving any other key.
 *
 * The visible keys keep the slots they already occupy and are refilled in the
 * new order; keys that are not visible stay exactly where they were. That keeps
 * a drag inside one host section from reordering projects that only appear in
 * another section — a shared project has one slot, not one per section.
 * Visible keys that are not yet in `currentOrder` append at the end.
 */
export function mergeVisibleReorderInPlace(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const queue = Array.from(new Set(input.reorderedVisibleKeys.filter((key) => key.length > 0)));
  const visibleSet = new Set(queue);
  const result: string[] = [];
  for (const key of input.currentOrder) {
    if (!visibleSet.has(key)) {
      result.push(key);
      continue;
    }
    const next = queue.shift();
    result.push(next ?? key);
  }
  result.push(...queue);
  return result;
}
