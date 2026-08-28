import { File as FSFile, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { CacheFile, DownloadPlatform, HttpDownloadRequest } from "./download-platform-types";

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  // Protects the local filesystem, not the wire: CJK and emoji are preserved.
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return { base: fileName.slice(0, lastDot), ext: fileName.slice(lastDot) };
}

function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const split = splitFileName(safeName);
  let targetFile = new FSFile(directory, safeName);
  let suffix = 1;

  while (targetFile.exists) {
    targetFile = new FSFile(directory, `${split.base} (${suffix})${split.ext}`);
    suffix += 1;
  }

  return targetFile;
}

export const downloadPlatform: DownloadPlatform = {
  isWeb: false,
  createCacheFile(fileName: string): CacheFile {
    const file = resolveDownloadTargetFile(fileName);
    file.create();
    const handle = file.open();
    return {
      uri: file.uri,
      write: (bytes) => handle.writeBytes(bytes),
      close: () => handle.close(),
      remove: () => file.delete(),
    };
  },

  isSharingAvailable: () => Sharing.isAvailableAsync(),

  deliverToBrowser() {
    throw new Error("Browser downloads are not available on native.");
  },

  share: (uri, options) => Sharing.shareAsync(uri, options),

  async downloadOverHttp({ url, fileName, authHeader, onProgress }: HttpDownloadRequest) {
    const targetFile = resolveDownloadTargetFile(fileName);
    const resumable = LegacyFileSystem.createDownloadResumable(
      url,
      targetFile.uri,
      authHeader ? { headers: { Authorization: authHeader } } : undefined,
      (data) => onProgress(data.totalBytesWritten, data.totalBytesExpectedToWrite),
    );
    const result = await resumable.downloadAsync();
    return result ? { uri: result.uri } : null;
  },
};
