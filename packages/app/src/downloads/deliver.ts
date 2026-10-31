import {
  shareCachedDownload,
  type CachedDownload,
  type FileDelivery,
} from "@/downloads/cached-download";

export const FILE_DELIVERIES: readonly FileDelivery[] = ["download"];

// iOS has no public Downloads folder; its share sheet carries "Save to Files".
export function deliverCachedDownload(
  file: CachedDownload,
  _delivery: FileDelivery,
): Promise<void> {
  return shareCachedDownload(file);
}
