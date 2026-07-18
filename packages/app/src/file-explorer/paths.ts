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

export function getExplorerEntryName(entryPath: string): string {
  const normalized = entryPath.trim();
  if (!normalized || normalized === ".") {
    return "";
  }
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export function joinExplorerPath(parentPath: string, name: string): string {
  const normalizedParent = parentPath.trim();
  const normalizedName = name.trim();
  if (!normalizedParent || normalizedParent === ".") {
    return normalizedName;
  }
  return `${normalizedParent.replace(/[\\/]+$/, "")}/${normalizedName}`;
}

export function buildExplorerRelativePath(absolutePath: string, workspaceRoot: string): string {
  const root = workspaceRoot.trim().replace(/[\\/]+$/, "");
  const target = absolutePath.trim();
  if (!root || !target.startsWith(root)) {
    return target;
  }
  const relative = target.slice(root.length).replace(/^[\\/]+/, "");
  return relative.length > 0 ? relative.replace(/\\/g, "/") : ".";
}
