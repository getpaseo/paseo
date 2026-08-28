/**
 * The platform work a download needs, kept behind an interface so the store carries no
 * Expo imports. Importing Expo at module scope is what made download-store untestable
 * without module mocks, which docs/testing.md forbids.
 *
 * Implementations: download-platform.ts (native) and download-platform.web.ts.
 */

export interface CacheFile {
  /** URI handed to the OS share sheet. */
  readonly uri: string;
  write(bytes: Uint8Array): void;
  close(): void;
  /** Removes a partial file so a failed transfer leaves nothing behind. */
  remove(): void;
}

export interface HttpDownloadRequest {
  url: string;
  fileName: string;
  authHeader: string | null;
  onProgress: (written: number, expected: number) => void;
}

export interface DownloadPlatform {
  /**
   * Which delivery shape this platform uses. The adapter knows; the store should not have
   * to import a platform constant to find out, which is also what made it untestable.
   */
  readonly isWeb: boolean;
  /** Creates the cache file a native download streams into. */
  createCacheFile(fileName: string): CacheFile;
  isSharingAvailable(): Promise<boolean>;
  share(uri: string, options: { mimeType?: string; dialogTitle?: string }): Promise<void>;
  /** COMPAT(httpFileDownload): the pre-binary-channel path, native side. */
  downloadOverHttp(request: HttpDownloadRequest): Promise<{ uri: string } | null>;
  /** Hands a URL to the browser as a download. Web only. */
  deliverToBrowser(url: string, fileName: string): void;
}
