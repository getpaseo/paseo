export interface PluginWorkspaceFileSystemTarget {
  cwd: string;
}

export type PluginWorkspaceFileSystemState =
  | "online"
  | "connecting"
  | "offline"
  | "error"
  | "unknown";

export interface PluginWorkspaceFileSystemStatus {
  state: PluginWorkspaceFileSystemState;
  detail?: string;
}

export interface PluginWorkspaceFileSystemPath extends PluginWorkspaceFileSystemTarget {
  path: string;
}

export interface PluginWorkspaceFileSystemReadRequest extends PluginWorkspaceFileSystemPath {
  maxBytes?: number;
}

export interface PluginWorkspaceFileSystemWriteRequest extends PluginWorkspaceFileSystemPath {
  content: string;
  expectedModifiedAt: string;
  expectedRevision?: string;
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
  getStatus?(
    target: PluginWorkspaceFileSystemTarget,
  ): PluginWorkspaceFileSystemStatus | Promise<PluginWorkspaceFileSystemStatus>;
  listDirectory(
    target: PluginWorkspaceFileSystemPath,
  ): PluginWorkspaceFileSystemDirectory | Promise<PluginWorkspaceFileSystemDirectory>;
  readFile(
    target: PluginWorkspaceFileSystemReadRequest,
  ): PluginWorkspaceFileSystemFile | Promise<PluginWorkspaceFileSystemFile>;
  statFile(
    target: PluginWorkspaceFileSystemPath,
  ): PluginWorkspaceFileVersion | Promise<PluginWorkspaceFileVersion>;
  writeFile?(
    target: PluginWorkspaceFileSystemWriteRequest,
  ): PluginWorkspaceFileWriteResult | Promise<PluginWorkspaceFileWriteResult>;
}
