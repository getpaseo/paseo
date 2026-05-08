export interface WorkspaceFilePreviewProps {
  filePath: string;
  bytes: Uint8Array;
  mimeType: string;
  size: number;
  modifiedAt: string;
}

export interface WorkspaceDrawioPreviewProps extends WorkspaceFilePreviewProps {
  onSave: (input: {
    bytes: Uint8Array;
    expectedModifiedAt: string;
    expectedSize: number;
  }) => Promise<void>;
}
