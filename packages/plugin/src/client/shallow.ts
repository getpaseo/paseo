function isIterable(value: object): value is Iterable<unknown> {
  return Symbol.iterator in value;
}

function hasEntries(value: object): value is { entries(): Iterable<[unknown, unknown]> } {
  return "entries" in value;
}

function compareEntries(
  left: { entries(): Iterable<[unknown, unknown]> },
  right: { entries(): Iterable<[unknown, unknown]> },
): boolean {
  const leftEntries = left instanceof Map ? left : new Map(left.entries());
  const rightEntries = right instanceof Map ? right : new Map(right.entries());
  if (leftEntries.size !== rightEntries.size) return false;
  for (const [key, value] of leftEntries) {
    if (!rightEntries.has(key) || !Object.is(value, rightEntries.get(key))) return false;
  }
  return true;
}

function compareIterables(left: Iterable<unknown>, right: Iterable<unknown>): boolean {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  let leftValue = leftIterator.next();
  let rightValue = rightIterator.next();
  while (!leftValue.done && !rightValue.done) {
    if (!Object.is(leftValue.value, rightValue.value)) return false;
    leftValue = leftIterator.next();
    rightValue = rightIterator.next();
  }
  return Boolean(leftValue.done && rightValue.done);
}

export function shallowEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (isIterable(left) && isIterable(right)) {
    if (hasEntries(left) && hasEntries(right)) return compareEntries(left, right);
    return compareIterables(left, right);
  }
  return compareEntries(
    { entries: () => Object.entries(left) },
    { entries: () => Object.entries(right) },
  );
}
