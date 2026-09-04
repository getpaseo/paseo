export function mergeWithRemainder(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key));
  return [...input.reorderedVisibleKeys, ...remainder];
}

// mergeWithRemainder front-loads the reordered keys ([...reorderedVisibleKeys, ...remainder]),
// which is correct when the reordered subset is the whole visible list (pinned section, a
// filtered view) but wrong for a partition like a project group: dragging {b, d} within a group
// over the global order [a, b, c, d] would produce [d, b, a, c], and both projects jump to the
// top of the *entire* sidebar the moment they leave the group. spliceReorderedKeys keeps every
// member in its original slot in currentOrder and only swaps in the new relative order, so
// members that stay in the group keep their position relative to everything else.
export function spliceReorderedKeys(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const currentSet = new Set(input.currentOrder);
  const present = input.reorderedVisibleKeys.filter((key) => currentSet.has(key));
  const appended = input.reorderedVisibleKeys.filter((key) => !currentSet.has(key));
  const reorderedSet = new Set(present);
  let cursor = 0;
  const result = input.currentOrder.map((key) => {
    if (!reorderedSet.has(key)) return key;
    const next = present[cursor];
    cursor += 1;
    return next;
  });
  return [...result, ...appended];
}

// moveKeyRelative is the primitive behind cross-group drag moves: unlike
// spliceReorderedKeys (which reorders a subset in place), this removes one
// key and reinserts it immediately before or after a named anchor, so a
// project row dragged into another group lands next to the row it was
// dropped on rather than at the front or back of the whole order.
export function moveKeyRelative(input: {
  currentOrder: string[];
  key: string;
  anchorKey: string;
  placement: "before" | "after";
}): string[] {
  const { currentOrder, key, anchorKey, placement } = input;
  if (key === anchorKey) return currentOrder;
  const withoutKey = currentOrder.filter((entry) => entry !== key);
  const anchorIndex = withoutKey.indexOf(anchorKey);
  if (anchorIndex === -1) {
    return [...withoutKey, key];
  }
  const insertIndex = placement === "before" ? anchorIndex : anchorIndex + 1;
  return [...withoutKey.slice(0, insertIndex), key, ...withoutKey.slice(insertIndex)];
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
 * Where a row dropped on a group header goes: ahead of the group's first row, and ahead of any
 * row that is still on its way into the group (`arrivingKeys`), so two quick drops on the same
 * header end up in drop order.
 */
export function groupStartAnchor(input: {
  currentOrder: string[];
  firstViewKey: string;
  arrivingKeys: ReadonlySet<string>;
}): string {
  const candidates = new Set([input.firstViewKey, ...input.arrivingKeys]);
  return input.currentOrder.find((key) => candidates.has(key)) ?? input.firstViewKey;
}
