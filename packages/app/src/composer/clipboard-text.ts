import type { PickedFile } from "@/attachments/picked-file";

export const PASTED_TEXT_FILE_NAME = "pasted-text.txt";
export const PASTED_TEXT_MIME_TYPE = "text/plain";
export const PASTED_TEXT_UPLOAD_THRESHOLD_BYTES = 10_000;

const textEncoder = new TextEncoder();

export function createPastedTextFile(text: string): PickedFile | null {
  if (text.length === 0) return null;
  return {
    fileName: PASTED_TEXT_FILE_NAME,
    mimeType: PASTED_TEXT_MIME_TYPE,
    bytes: textEncoder.encode(text),
  };
}

export function createAutomaticPastedTextFile(text: string): PickedFile | null {
  const file = createPastedTextFile(text);
  if (!file || file.bytes.byteLength < PASTED_TEXT_UPLOAD_THRESHOLD_BYTES) {
    return null;
  }
  return file;
}

export function restoreFailedPastedText(input: {
  currentText: string;
  initialText: string;
  pastedText: string;
  selectionStart: number;
  selectionEnd: number;
}): string {
  if (input.currentText !== input.initialText) {
    return input.currentText + input.pastedText;
  }
  return (
    input.initialText.slice(0, input.selectionStart) +
    input.pastedText +
    input.initialText.slice(input.selectionEnd)
  );
}
