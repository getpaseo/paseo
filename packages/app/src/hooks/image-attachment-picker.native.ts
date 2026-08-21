import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import {
  normalizePickedImageAssetsWith,
  type ExpoImagePickerAssetLike,
  type PickedImageAttachmentInput,
} from "./picked-image-normalizer";
import {
  normalizePickedMediaAssetsWith,
  type ExpoMediaPickerAssetLike,
  type PickedMediaAttachmentInput,
} from "./picked-media-normalizer";

export type {
  ExportPickedImageAsPng,
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
  PickedImageSource,
} from "./picked-image-normalizer";
export type {
  ExpoMediaPickerAssetLike,
  PickedMediaAttachmentInput,
} from "./picked-media-normalizer";

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

export async function normalizePickedMediaAssets(
  assets: readonly ExpoMediaPickerAssetLike[],
): Promise<PickedMediaAttachmentInput[]> {
  return normalizePickedMediaAssetsWith({
    assets,
    normalizeImage: async (asset) => {
      const [attachment] = await normalizePickedImageAssets([asset]);
      if (!attachment) {
        throw new Error(`Failed to normalize picked image '${asset.uri}'.`);
      }
      return attachment;
    },
    readVideoBytes: async (uri) => await new File(uri).bytes(),
  });
}

export async function pickImagesWithDesktopDialog(
  _dialog?: unknown,
): Promise<PickedImageAttachmentInput[]> {
  throw new Error("Desktop dialog API is not available on native.");
}
