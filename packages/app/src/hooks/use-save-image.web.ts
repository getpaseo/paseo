import { useCallback } from "react";

/**
 * Returns a callback that triggers an image download in web browsers.
 * Uses blob URLs to prevent navigating away from the app when downloading cross-origin images.
 */
export function useSaveImage() {
  return useCallback(async (uri: string) => {
    if (!uri) return;

    let safeName = "image.png";
    try {
      const parsed = new URL(uri, window.location.href);
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

    // Direct download for blob and data URLs (same-origin / inline)
    if (uri.startsWith("data:") || uri.startsWith("blob:")) {
      const link = document.createElement("a");
      link.href = uri;
      link.download = safeName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }

    // Remote images: fetch blob first so <a download> is not ignored for cross-origin URLs
    try {
      const response = await fetch(uri);
      if (!response.ok) {
        throw new Error(`Failed to fetch image (${response.status} ${response.statusText})`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = safeName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      // If fetching the blob is blocked (e.g. CORS), open in a new tab without replacing the app
      window.open(uri, "_blank", "noopener,noreferrer");
    }
  }, []);
}
