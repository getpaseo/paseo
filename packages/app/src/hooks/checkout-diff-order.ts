import type { SubscribeCheckoutDiffResponse } from "@server/shared/messages";

type ParsedDiffFile = SubscribeCheckoutDiffResponse["payload"]["files"][number];

export function compareCheckoutDiffPaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function orderCheckoutDiffFiles(
  files: ParsedDiffFile[]
): ParsedDiffFile[] {
  if (files.length < 2) {
    return files;
  }
  const ordered = [...files];
  ordered.sort((a, b) => compareCheckoutDiffPaths(a.path, b.path));
  return ordered;
}
