import { useCallback } from "react";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { isWeb } from "@/constants/platform";
import { useTranslation } from "react-i18next";

/**
 * Returns a callback that downloads an image from a remote URI to a local cache file
 * and then opens the system share sheet so the user can save it to their device.
 * On web, it triggers a browser download instead.
 */
export function useSaveImage() {
  const { t } = useTranslation();

  return useCallback(
    async (uri: string) => {
      if (!uri) return;

      if (isWeb) {
        // On web, trigger a browser download via an anchor element.
        const link = document.createElement("a");
        link.href = uri;
        link.download = "";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }

      try {
        // Derive a filename from the URI (fall back to "image").
        let safeName = "image";
        try {
          const url = new URL(uri);
          const pathname = url.pathname;
          const filename = pathname.substring(pathname.lastIndexOf("/") + 1);
          if (filename) {
            safeName = filename.replace(/[\\/:*?"<>|]+/g, "_");
          }
        } catch {
          // Ignore URL parse errors; use default filename.
        }

        const directory = LegacyFileSystem.cacheDirectory ?? LegacyFileSystem.documentDirectory;
        if (!directory) {
          throw new Error("No cache directory available.");
        }

        const targetUri = `${directory}${safeName}`;

        // Download the remote image to a local cache file.
        const result = await LegacyFileSystem.downloadAsync(uri, targetUri);
        if (!result?.uri) {
          throw new Error("Download returned no URI.");
        }

        // Open the share sheet so the user can save to Photos, Files, etc.
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(result.uri, {
            dialogTitle: t("message.attachments.downloadImage"),
          });
        }
      } catch (error) {
        // Silently fail — the share sheet or download may not be available.
        console.warn("[useSaveImage] Failed to save image:", error);
      }
    },
    [t],
  );
}
