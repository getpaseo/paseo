import { openExternalUrl } from "@/utils/open-external-url";
import type { DownloadPlatform } from "./download-platform-types";

/**
 * Web never reaches these: the browser branch collects Blob parts and clicks an object
 * URL rather than writing a cache file, and the HTTP fallback navigates instead of
 * streaming to disk. Failing loudly beats pretending to have written something.
 */
function unavailable(operation: string): never {
  throw new Error(`${operation} is not available on web.`);
}

export const downloadPlatform: DownloadPlatform = {
  isWeb: true,
  createCacheFile: () => unavailable("Writing a download cache file"),

  deliverToBrowser(url: string, fileName: string) {
    if (typeof document === "undefined") {
      if (typeof window !== "undefined") {
        void openExternalUrl(url);
      }
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  },
  isSharingAvailable: async () => false,
  share: async () => unavailable("Sharing a downloaded file"),
  downloadOverHttp: async () => unavailable("Streaming an HTTP download to disk"),
};
