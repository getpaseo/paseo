export interface WorkspaceFileSearchEntry {
  path: string;
  name: string;
  directory: string;
}

export function describeWorkspaceFilePath(path: string): WorkspaceFileSearchEntry {
  const normalized = path.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  return {
    path: normalized,
    name: separator >= 0 ? normalized.slice(separator + 1) : normalized,
    directory: separator >= 0 ? normalized.slice(0, separator) : "",
  };
}
