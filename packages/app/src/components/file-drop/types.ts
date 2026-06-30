import type { ImageAttachment } from "@/composer/types";

export interface DroppedFileItem {
  kind: "web-file";
  file: File;
}
export interface DroppedPathItem {
  kind: "desktop-path";
  path: string;
}
export type DroppedItem = DroppedFileItem | DroppedPathItem;

/**
 * What a consumer (e.g. a composer) registers to receive files dropped onto the
 * surrounding FileDropZone. Raster images arrive already persisted via `onFiles`;
 * everything else arrives raw via `onGenericFiles`.
 */
export interface FileDropSink {
  onFiles: (images: ImageAttachment[]) => void;
  onGenericFiles?: (items: DroppedItem[]) => void;
}
