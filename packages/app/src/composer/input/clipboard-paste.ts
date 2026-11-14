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
  attachImages: ((files: ClipboardImageFile[]) => void) | undefined;
  insertText: (text: string) => void;
  /** Attachments belong to the chat composer; a terminal prompt keeps every paste as text. */
  showAttachments: boolean;
}

export function handleClipboardPaste(input: ClipboardPasteInput): void {
  const text = input.event.clipboardData?.getData("text/plain") ?? "";
  const images =
    input.showAttachments && input.attachImages
      ? collectImageFilesFromClipboardData(input.event.clipboardData)
      : [];
  const isLarge =
    input.showAttachments && Boolean(input.attachText) && text.length >= LARGE_PASTE_THRESHOLD;
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
  if (images.length > 0) input.attachImages?.(images);
}
