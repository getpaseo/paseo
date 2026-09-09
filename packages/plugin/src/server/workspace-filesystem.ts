export interface PluginWorkspaceFileSystemTarget {
  cwd: string;
}

export interface PluginWorkspaceFileSystemPath extends PluginWorkspaceFileSystemTarget {
  path: string;
}

export interface PluginWorkspaceFileSystemEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}

export interface PluginWorkspaceFileSystemDirectory {
  path: string;
  entries: PluginWorkspaceFileSystemEntry[];
}

export interface PluginWorkspaceFileSystemFile {
  path: string;
  kind: "text" | "image" | "binary";
  encoding: "utf-8" | "base64" | "none";
  content?: string;
  mimeType?: string;
  size: number;
  modifiedAt: string;
  revision?: string;
}

export type PluginWorkspaceFileVersion =
  | {
      status: "ready";
      cwd: string;
      path: string;
      size: number;
      modifiedAt: string;
      revision?: string;
    }
  | { status: "missing"; cwd: string; path: string }
  | { status: "error"; cwd: string; path: string; error: string };

export type PluginWorkspaceFileWriteResult =
  | { status: "written"; modifiedAt: string; size: number; revision?: string }
  | { status: "conflict"; version: PluginWorkspaceFileVersion }
  | { status: "error"; error: string };

export interface PluginWorkspaceFileSystemProvider {
  id: string;
  matches(target: PluginWorkspaceFileSystemTarget): boolean | Promise<boolean>;
  listDirectory(
    target: PluginWorkspaceFileSystemPath,
  ): PluginWorkspaceFileSystemDirectory | Promise<PluginWorkspaceFileSystemDirectory>;
  readFile(
    target: PluginWorkspaceFileSystemPath & { maxBytes?: number },
  ): PluginWorkspaceFileSystemFile | Promise<PluginWorkspaceFileSystemFile>;
  statFile(
    target: PluginWorkspaceFileSystemPath,
  ): PluginWorkspaceFileVersion | Promise<PluginWorkspaceFileVersion>;
  writeFile?(
    target: PluginWorkspaceFileSystemPath & {
      content: string;
      expectedModifiedAt: string;
      expectedRevision?: string;
    },
  ): PluginWorkspaceFileWriteResult | Promise<PluginWorkspaceFileWriteResult>;
}
