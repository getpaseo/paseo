import type { ImageAttachment } from "@/composer/types";
import type { WorkspaceFileDragPayload } from "@/attachments/workspace-file-drag";

export interface DroppedFileItem {
  kind: "web-file";
  file: File;
  /**
   * Path inside a dropped folder, when the sink opted into directory expansion.
   * Absent for a plain file drop.
   */
  relativePath?: string;
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
  /** Omitted by a sink that takes raw files instead of persisted image attachments. */
  onFiles?: (images: ImageAttachment[]) => void;
  onGenericFiles?: (items: DroppedItem[]) => void;
  onWorkspaceFile?: (payload: WorkspaceFileDragPayload) => void;
  /**
   * Take dropped bytes as-is: folders are expanded into their files, each tagged with
   * `relativePath`, and raster images are not persisted as attachments. Everything
   * arrives through `onGenericFiles`.
   */
  rawFiles?: boolean;
}
