export function getExplorerParentPath(entryPath: string): string {
  const normalized = entryPath.trim();
  if (!normalized || normalized === ".") {
    return ".";
  }
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 1) {
    return ".";
  }
  return segments.slice(0, -1).join("/");
}
