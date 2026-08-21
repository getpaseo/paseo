import { getMimeTypeFromPath } from "@/attachments/file-types";
import type { PickedFile } from "@/attachments/picked-file";
import { getFileNameFromPath } from "@/attachments/utils";
import type {
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
} from "./picked-image-normalizer";

export interface ExpoMediaPickerAssetLike extends ExpoImagePickerAssetLike {
  type?: "image" | "video" | "livePhoto" | "pairedVideo" | null;
}

export type PickedMediaAttachmentInput =
  | { kind: "image"; attachment: PickedImageAttachmentInput }
  | { kind: "file"; file: PickedFile };

type NormalizePickedImage = (
  asset: ExpoImagePickerAssetLike,
) => Promise<PickedImageAttachmentInput>;

type ReadPickedVideoBytes = (uri: string) => Promise<Uint8Array>;

function isPickedVideo(asset: ExpoMediaPickerAssetLike): boolean {
  return asset.type === "video" || asset.mimeType?.toLowerCase().startsWith("video/") === true;
}

function pickedVideoFileName(asset: ExpoMediaPickerAssetLike): string {
  return asset.fileName ?? getFileNameFromPath(asset.uri) ?? "video";
}

export async function normalizePickedMediaAssetsWith(input: {
  assets: readonly ExpoMediaPickerAssetLike[];
  normalizeImage: NormalizePickedImage;
  readVideoBytes: ReadPickedVideoBytes;
}): Promise<PickedMediaAttachmentInput[]> {
  return await Promise.all(
    input.assets.map(async (asset) => {
      if (isPickedVideo(asset)) {
        const fileName = pickedVideoFileName(asset);
        return {
          kind: "file" as const,
          file: {
            fileName,
            mimeType: asset.mimeType ?? getMimeTypeFromPath(fileName),
            bytes: await input.readVideoBytes(asset.uri),
          },
        };
      }

      const attachment = await input.normalizeImage(asset);
      return { kind: "image" as const, attachment };
    }),
  );
}
