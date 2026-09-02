import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { createPreviewAttachmentId, getFileNameFromPath } from "@/attachments/utils";

export interface ImagePreviewAttachmentPort {
  persist(input: {
    id: string;
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

export type ImagePreviewAttachmentResult =
  | { status: "ready"; attachment: AttachmentMetadata }
  | { status: "error"; attachment: null };

export async function prepareImagePreviewAttachment(
  file: FileReadResult,
  port: ImagePreviewAttachmentPort,
): Promise<ImagePreviewAttachmentResult> {
  try {
    const attachment = await port.persist({
      id: createPreviewAttachmentId({
        mimeType: file.mime,
        path: file.path,
        size: file.size,
        modifiedAt: file.modifiedAt,
        contentLength: file.bytes.byteLength,
        contentKey: file.revision,
      }),
      bytes: file.bytes,
      mimeType: file.mime,
      fileName: getFileNameFromPath(file.path),
    });
    return { status: "ready", attachment };
  } catch {
    return { status: "error", attachment: null };
  }
}
