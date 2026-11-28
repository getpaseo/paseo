import * as FileSystem from "expo-file-system/legacy";
import { i18n } from "@/i18n/i18next";

export interface NativeDownloadOptions {
  url: string;
  destination: string;
  headers?: Record<string, string>;
  onProgress: (data: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void;
}

export async function downloadFile(options: NativeDownloadOptions): Promise<string> {
  const download = FileSystem.createDownloadResumable(
    options.url,
    options.destination,
    options.headers ? { headers: options.headers } : undefined,
    options.onProgress,
  );
  const result = await download.downloadAsync();
  if (!result) throw new Error(i18n.t("downloads.cancelled"));
  return result.uri;
}
