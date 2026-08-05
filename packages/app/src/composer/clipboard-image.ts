import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

interface ClipboardImage {
  data: string;
}

export interface ClipboardImageReader {
  hasImageAsync: () => Promise<boolean>;
  getImageAsync: (options: { format: "png" }) => Promise<ClipboardImage | null>;
}

export async function readClipboardImage(
  clipboard: ClipboardImageReader,
): Promise<PickedImageAttachmentInput | null> {
  if (!(await clipboard.hasImageAsync())) {
    return null;
  }

  const image = await clipboard.getImageAsync({ format: "png" });
  if (!image) {
    return null;
  }

  return {
    source: { kind: "data_url", dataUrl: image.data },
    mimeType: "image/png",
    fileName: "clipboard.png",
  };
}
