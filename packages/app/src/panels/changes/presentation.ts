export function resolveChangesPresentation(input: {
  isTree: boolean;
  inlineDiff: boolean;
  isCompact: boolean;
  isNative: boolean;
}): "tree" | "diff" | "combined" {
  if (!input.isTree) return "diff";
  return input.isCompact || input.isNative || input.inlineDiff ? "combined" : "tree";
}
