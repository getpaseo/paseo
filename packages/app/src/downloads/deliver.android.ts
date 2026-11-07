import { CodedError, requireNativeModule } from "expo-modules-core";
import * as LegacyFileSystem from "expo-file-system/legacy";
import { i18n } from "@/i18n/i18next";
import {
  shareCachedDownload,
  type CachedDownload,
  type FileDelivery,
} from "@/downloads/cached-download";

interface PaseoAndroidFilesModule {
  moveToDownloads(sourceUri: string, displayName: string, mimeType: string | null): Promise<string>;
  notifyDownloaded(contentUri: string, channelName: string, message: string): Promise<void>;
  openWith(contentUri: string, fileName: string, mimeType: string | null): Promise<void>;
}

const androidFiles = requireNativeModule<PaseoAndroidFilesModule>("PaseoAndroidFiles");

export const FILE_DELIVERIES: readonly FileDelivery[] = ["download", "share", "openWith"];

class NoFileHandlerError extends Error {
  constructor(readonly fileName: string) {
    super(i18n.t("downloads.noAppToOpen", { fileName }));
    this.name = "NoFileHandlerError";
  }
}

export async function deliverCachedDownload(
  file: CachedDownload,
  delivery: FileDelivery,
): Promise<void> {
  switch (delivery) {
    case "download": {
      const savedUri = await androidFiles.moveToDownloads(file.uri, file.fileName, file.mimeType);
      await androidFiles.notifyDownloaded(
        savedUri,
        i18n.t("downloads.notificationChannel"),
        i18n.t("common.states.downloadComplete"),
      );
      return;
    }
    case "share":
      await shareCachedDownload(file);
      return;
    case "openWith":
      await openWith(file);
      return;
  }
}

async function openWith(file: CachedDownload): Promise<void> {
  // Other apps can't read a file:// URI into Paseo's private cache. The FileProvider content URI
  // travels with a read grant on the intent.
  const contentUri = await LegacyFileSystem.getContentUriAsync(file.uri);
  try {
    await androidFiles.openWith(contentUri, file.fileName, file.mimeType);
  } catch (error) {
    if (error instanceof CodedError && error.code === "ERR_NO_FILE_HANDLER") {
      throw new NoFileHandlerError(file.fileName);
    }
    throw error;
  }
}
