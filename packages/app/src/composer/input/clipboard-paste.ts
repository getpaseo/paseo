import type { SelectedFile } from "@/attachments/selected-file";
import {
  collectImageFilesFromClipboardData,
  type ClipboardImageFile,
} from "@/utils/image-attachments-from-files";

// Keep in sync with the native paste-input interception in patches/.
export const LARGE_PASTE_THRESHOLD = 5_000;

interface ClipboardPasteInput {
  event: ClipboardEvent;
  attachText: ((file: SelectedFile) => void) | undefined;
  attachImages: (files: ClipboardImageFile[]) => void;
  insertText: (text: string) => void;
}

export function handleClipboardPaste(input: ClipboardPasteInput): void {
  const text = input.event.clipboardData?.getData("text/plain") ?? "";
  const images = collectImageFilesFromClipboardData(input.event.clipboardData);
  const isLarge = text.length >= LARGE_PASTE_THRESHOLD && Boolean(input.attachText);
  if (!isLarge && images.length === 0) return;

  input.event.preventDefault();
  if (isLarge) {
    input.attachText?.({
      fileName: `pasted-text-${Date.now()}.txt`,
      mimeType: "text/plain",
      readBytes: async () => new TextEncoder().encode(text),
    });
  } else if (text) {
    input.insertText(text);
  }
  if (images.length > 0) input.attachImages(images);
}
