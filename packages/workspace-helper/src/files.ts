export type WorkspaceFileKind = "text" | "image" | "binary";

export type WorkspaceFileStat =
  | {
      status: "ready";
      path: string;
      kind: WorkspaceFileKind;
      encoding: "utf-8" | "binary";
      mimeType: string;
      size: number;
      modifiedAt: string;
      revision: string;
    }
  | { status: "missing"; path: string }
  | { status: "error"; path: string; error: string };

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}

export interface WorkspaceDirectory {
  path: string;
  entries: WorkspaceDirectoryEntry[];
}

export interface WorkspaceFileRead {
  path: string;
  kind: WorkspaceFileKind;
  encoding: "utf-8" | "binary";
  mimeType: string;
  size: number;
  modifiedAt: string;
  revision: string;
  chunks: WorkspaceFileContent;
}

export interface WorkspaceFileContent extends AsyncIterable<Uint8Array> {
  /** Stops an incomplete transfer and resolves only after its helper process exits. */
  cancel(): Promise<void>;
}

export type WorkspaceFileWriteResult =
  | { status: "written"; modifiedAt: string; size: number; revision: string }
  | { status: "conflict"; version: WorkspaceFileStat }
  | { status: "error"; error: string };

export type WorkspaceWatchEvent =
  | { type: "changed"; paths: string[] }
  | { type: "overflow" }
  | { type: "error"; error: string };

export interface WorkspaceFilesSubscription {
  unsubscribe(): Promise<void>;
}

export interface WorkspaceFiles {
  stat(path: string): Promise<WorkspaceFileStat>;
  list(path: string): Promise<WorkspaceDirectory>;
  read(path: string): Promise<WorkspaceFileRead>;
  write(input: {
    path: string;
    contents: Uint8Array | AsyncIterable<Uint8Array>;
    expectedModifiedAt?: string;
    expectedRevision?: string;
  }): Promise<WorkspaceFileWriteResult>;
  subscribe(
    input: { paths: readonly string[]; recursive?: boolean; ignoredPaths?: readonly string[] },
    listener: (event: WorkspaceWatchEvent) => void,
  ): Promise<WorkspaceFilesSubscription>;
}
