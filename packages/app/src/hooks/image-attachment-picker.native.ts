import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

export type PickedImageSource = { kind: "file_uri"; uri: string } | { kind: "blob"; blob: Blob };

export interface PickedImageAttachmentInput {
  source: PickedImageSource;
  mimeType?: string | null;
  fileName?: string | null;
}

export interface ExpoImagePickerAssetLike {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  file?: File | null;
}

function replaceWithJpegExtension(fileName: string | null | undefined): string | null {
  if (!fileName) {
    return null;
  }

  return fileName.replace(/\.[^./\\]+$/, "") + ".jpg";
}

async function exportPickedImageAsJpeg(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;

  try {
    image = await context.renderAsync();
    const result = await image.saveAsync({
      compress: 0.92,
      format: SaveFormat.JPEG,
    });
    return result.uri;
  } finally {
    image?.release();
    context.release();
  }
}

export async function normalizePickedImageAssets(
  assets: readonly ExpoImagePickerAssetLike[],
): Promise<PickedImageAttachmentInput[]> {
  return await Promise.all(
    assets.map(async (asset) => {
      const convertedUri = await exportPickedImageAsJpeg(asset.uri);

      return {
        source: { kind: "file_uri", uri: convertedUri },
        mimeType: "image/jpeg",
        fileName: replaceWithJpegExtension(asset.fileName),
      };
    }),
  );
}

export async function openImagePathsWithDesktopDialog(): Promise<string[]> {
  throw new Error("Desktop dialog API is not available on native.");
}
