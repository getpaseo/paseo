export function resolveComposerCapacity(input: {
  height: number;
  bottomInset: number;
  keyboardShift: number;
  centered: boolean;
}): number {
  "worklet";
  // A centered form grows upward by half its height. Reserve both halves so
  // translating it still leaves five layout points below the header.
  const clearance = input.keyboardShift + 5;
  const reservedSpace = input.centered ? clearance * 2 : clearance;
  return Math.max(0, input.height - input.bottomInset - reservedSpace);
}
