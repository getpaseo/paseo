import type { ImageAttachment } from "@/composer/types";
import type { WorkspaceFileDragPayload } from "@/attachments/workspace-file-drag";

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
 * surrounding FileDropZone. Every file arrives raw via `onGenericFiles`; a sink that
 * also provides `onFiles` gets its raster images persisted as attachments.
 */
export interface FileDropSink {
  onFiles?: (images: ImageAttachment[]) => void;
  onGenericFiles?: (items: DroppedItem[]) => void;
  onWorkspaceFile?: (payload: WorkspaceFileDragPayload) => void;
}
