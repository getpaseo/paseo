/**
 * Shared by the three platform implementations of `components/pdf-preview`.
 * Each takes the superset: the web shell needs only the bytes (it mints a blob
 * URL), while a native viewer has to be pointed at a file on disk, which needs
 * a stable name and identity.
 */
export interface PdfPreviewDocument {
  bytes: Uint8Array;
  /**
   * Content-addressed identity for the on-disk copy, so reopening the same file
   * reuses it instead of writing a new one.
   */
  cacheId: string;
  fileName: string;
}

export interface PdfPreviewProps extends PdfPreviewDocument {
  /**
   * Offered when the preview cannot render — on Android, where there is no
   * system viewer, downloading is the only way to read the file, and the share
   * sheet that follows is what hands it to a PDF app. Absent when the file
   * cannot be downloaded (it lives outside the workspace the daemon will issue
   * a token for).
   */
  onDownload?: () => void;
  testID?: string;
}

/**
 * WKWebView will only read a file URL it has been granted access to, and the
 * grant is expressed as a directory.
 */
export function parentDirectoryUri(fileUri: string): string {
  const lastSlash = fileUri.lastIndexOf("/");
  return lastSlash <= 0 ? fileUri : fileUri.slice(0, lastSlash + 1);
}
