import { useCallback } from "react";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useTranslation } from "react-i18next";

/**
 * Returns a callback that saves or shares an image on native mobile platforms (Android and iOS).
 * For local files (e.g. file:// or content://), it opens the system share sheet directly.
 * For data URLs, it decodes and writes them to cache before sharing.
 * For remote URLs, it downloads the image to a cache file before opening the share sheet.
 */
export function useSaveImage() {
  const { t } = useTranslation();

  return useCallback(
    async (uri: string) => {
      if (!uri) return;

      const isSharingAvailable = await Sharing.isAvailableAsync();
      if (!isSharingAvailable) {
        throw new Error("Sharing is not available on this device.");
      }

      // Local file URIs already exist on disk (e.g. cached attachments or camera captures)
      if (uri.startsWith("file://") || uri.startsWith("content://")) {
        await Sharing.shareAsync(uri, {
          dialogTitle: t("message.attachments.downloadImage"),
        });
        return;
      }

      const directory = LegacyFileSystem.cacheDirectory ?? LegacyFileSystem.documentDirectory;
      if (!directory) {
        throw new Error("No storage directory available.");
      }

      // Data URLs (data:image/...) need to be saved to disk first
      if (uri.startsWith("data:")) {
        const commaIndex = uri.indexOf(",");
        if (commaIndex === -1) {
          throw new Error("Invalid data URL.");
        }
        const base64Data = uri.substring(commaIndex + 1);
        const targetUri = `${directory}image_${Date.now()}.png`;
        await LegacyFileSystem.writeAsStringAsync(targetUri, base64Data, {
          encoding: LegacyFileSystem.EncodingType.Base64,
        });
        await Sharing.shareAsync(targetUri, {
          dialogTitle: t("message.attachments.downloadImage"),
        });
        return;
      }

      // Remote URLs: derive filename from pathname
      let safeName = "image.png";
      try {
        const parsed = new URL(uri);
        const pathname = parsed.pathname;
        const filename = pathname.substring(pathname.lastIndexOf("/") + 1);
        if (filename) {
          safeName = filename.replace(/[\\/:*?"<>|]+/g, "_");
        }
      } catch {
        // Fall back to default filename on URL parse failure
      }
      if (!safeName.includes(".")) {
        safeName = `${safeName}.png`;
      }

      const targetUri = `${directory}${safeName}`;
      const result = await LegacyFileSystem.downloadAsync(uri, targetUri);
      if (!result?.uri) {
        throw new Error("Download returned no URI.");
      }

      await Sharing.shareAsync(result.uri, {
        dialogTitle: t("message.attachments.downloadImage"),
      });
    },
    [t],
  );
}
