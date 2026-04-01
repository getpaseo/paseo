import { isAbsolutePath } from "./path";

interface BuildAbsoluteExplorerPathInput {
  workspaceRoot: string;
  entryPath: string;
}

export function buildAbsoluteExplorerPath({
  workspaceRoot,
  entryPath,
}: BuildAbsoluteExplorerPathInput): string {
  const normalizedWorkspaceRoot = workspaceRoot.trim().replace(/[\\/]+$/, "");
  const normalizedEntryPath = entryPath.trim();

  if (!normalizedWorkspaceRoot) {
    return normalizedEntryPath;
  }

  if (!normalizedEntryPath || normalizedEntryPath === ".") {
    return normalizedWorkspaceRoot;
  }

  if (isAbsolutePath(normalizedEntryPath)) {
    return normalizedEntryPath;
  }

  const separator = normalizedWorkspaceRoot.includes("\\") ? "\\" : "/";
  const segments = normalizedEntryPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return normalizedWorkspaceRoot;
  }

  return `${normalizedWorkspaceRoot}${separator}${segments.join(separator)}`;
}
