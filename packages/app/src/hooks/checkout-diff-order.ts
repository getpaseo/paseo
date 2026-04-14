interface DiffFileWithPath {
  path: string;
}

export function compareCheckoutDiffPaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function orderCheckoutDiffFiles<T extends DiffFileWithPath>(files: T[]): T[] {
  if (files.length < 2) {
    return files;
  }
  const ordered = [...files];
  ordered.sort((a, b) => compareCheckoutDiffPaths(a.path, b.path));
  return ordered;
}
