import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  normalizePickedImageAssetsWith,
  type ExpoImagePickerAssetLike,
  type PickedImageAttachmentInput,
  type RenderPickedImageOptions,
} from "./picked-image-normalizer";

export type {
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
  PickedImageSource,
  RenderPickedImage,
} from "./picked-image-normalizer";

async function renderPickedImage(uri: string, options: RenderPickedImageOptions): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;

  try {
    if (options.resize) {
      context.resize(options.resize);
    }
    image = await context.renderAsync();
    const result = await image.saveAsync(
      options.format === "jpeg"
        ? { format: SaveFormat.JPEG, compress: options.compress }
        : { format: SaveFormat.PNG },
    );
    return result.uri;
  } finally {
    image?.release();
    context.release();
  }
}

export async function normalizePickedImageAssets(
  assets: readonly ExpoImagePickerAssetLike[],
): Promise<PickedImageAttachmentInput[]> {
  return normalizePickedImageAssetsWith(assets, renderPickedImage);
}

export async function pickImagesWithDesktopDialog(
  _dialog?: unknown,
): Promise<PickedImageAttachmentInput[]> {
  throw new Error("Desktop dialog API is not available on native.");
}
