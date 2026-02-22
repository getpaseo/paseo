import type { AttachmentMetadata } from "@/attachments/types";
import { encodeAttachmentsForSend } from "@/attachments/service";

type ImageInput = AttachmentMetadata;

export async function encodeImages(
  images?: ImageInput[]
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  return await encodeAttachmentsForSend(images);
}
