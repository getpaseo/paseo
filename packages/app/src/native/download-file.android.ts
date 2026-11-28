import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import type { NativeDownloadOptions } from "./download-file";
import { downloadFile as legacyDownload } from "./download-file-legacy";

interface CertificateDownloads {
  selected(host: string, port: number): string | null;
  download(
    url: string,
    destination: string,
    headers: Record<string, string>,
    id: string,
  ): Promise<string>;
  addListener(
    event: "downloadProgress",
    listener: (progress: {
      id: string;
      totalBytesWritten: number;
      totalBytesExpectedToWrite: number;
    }) => void,
  ): EventSubscription;
}

const certificates = requireNativeModule<CertificateDownloads>("PaseoMtls");
let nextDownload = 0;

export async function downloadFile(options: NativeDownloadOptions): Promise<string> {
  const target = new URL(options.url);
  if (
    target.protocol !== "https:" ||
    certificates.selected(target.hostname.replace(/^\[|\]$/g, ""), Number(target.port || 443)) ===
      null
  ) {
    return legacyDownload(options);
  }
  const id = String(++nextDownload);
  const subscription = certificates.addListener("downloadProgress", (progress) => {
    if (progress.id === id) options.onProgress(progress);
  });
  try {
    return await certificates.download(options.url, options.destination, options.headers ?? {}, id);
  } finally {
    subscription.remove();
  }
}
