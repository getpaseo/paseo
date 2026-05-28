import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  normalizePickedImageAssetsWith,
  type ExpoImagePickerAssetLike,
  type PickedImageAttachmentInput,
} from "./picked-image-normalizer";

export type {
  ExportPickedImageAsPng,
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
  PickedImageSource,
} from "./picked-image-normalizer";

async function exportPickedImageAsPng(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;

  try {
    image = await context.renderAsync();
    const result = await image.saveAsync({
      format: SaveFormat.PNG,
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
  return normalizePickedImageAssetsWith(assets, exportPickedImageAsPng);
}

export async function openImagePathsWithDesktopDialog(_dialog?: unknown): Promise<string[]> {
  throw new Error("Desktop dialog API is not available on native.");
}
