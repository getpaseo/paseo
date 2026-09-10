export interface WorkspaceFileSearchEntry {
  path: string;
  name: string;
  directory: string;
}

/** Splits a workspace-relative path the host produced, where "/" is the only separator. */
export function describeWorkspaceFilePath(path: string): WorkspaceFileSearchEntry {
  const separator = path.lastIndexOf("/");
  return {
    path,
    name: separator >= 0 ? path.slice(separator + 1) : path,
    directory: separator >= 0 ? path.slice(0, separator) : "",
  };
}
