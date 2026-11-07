import * as Sharing from "expo-sharing";
import { i18n } from "@/i18n/i18next";

/** What the user asked to do with a host file once it reaches the device. */
export type FileDelivery = "download" | "share" | "openWith";

/** A host file written to the app cache, waiting to be handed to the platform. */
export interface CachedDownload {
  uri: string;
  fileName: string;
  mimeType: string | null;
}

export async function shareCachedDownload({
  uri,
  fileName,
  mimeType,
}: CachedDownload): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: mimeType ?? undefined,
      dialogTitle: fileName
        ? i18n.t("downloads.shareFileNamed", { fileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}
