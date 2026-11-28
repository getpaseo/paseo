import { isAbsolutePath } from "./path";

interface BuildAbsoluteExplorerPathInput {
  workspaceRoot: string;
  entryPath: string;
}

export function buildAbsoluteExplorerPath({
  workspaceRoot,
  entryPath,
}: BuildAbsoluteExplorerPathInput): string {
  const root = workspaceRoot.trim();
  const entry = entryPath.trim();
  if (!root || isAbsolutePath(entry)) {
    return entry;
  }

  const prefix = root.replace(/[\\/]+$/, "");
  // Retain one separator on a filesystem root, including a Windows drive root.
  const directory =
    isAbsolutePath(root) && !isAbsolutePath(prefix) ? root.slice(0, prefix.length + 1) : prefix;
  const segments = entry.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || entry === ".") {
    return directory;
  }

  const separator = directory.includes("\\") ? "\\" : "/";
  return [prefix, ...segments].join(separator);
}

export function parentExplorerPath(entryPath: string): string {
  const separatorIndex = entryPath.lastIndexOf("/");
  return separatorIndex > 0 ? entryPath.slice(0, separatorIndex) : ".";
}
