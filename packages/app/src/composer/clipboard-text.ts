import type { PickedFile } from "@/attachments/picked-file";

export const PASTED_TEXT_FILE_NAME = "pasted-text.txt";
export const PASTED_TEXT_MIME_TYPE = "text/plain";
export const PASTED_TEXT_UPLOAD_THRESHOLD_BYTES = 10_000;

const textEncoder = new TextEncoder();

export function createPastedTextFile(text: string): PickedFile | null {
  const bytes = textEncoder.encode(text);
  if (bytes.byteLength < PASTED_TEXT_UPLOAD_THRESHOLD_BYTES) {
    return null;
  }
  return {
    fileName: PASTED_TEXT_FILE_NAME,
    mimeType: PASTED_TEXT_MIME_TYPE,
    bytes,
  };
}
