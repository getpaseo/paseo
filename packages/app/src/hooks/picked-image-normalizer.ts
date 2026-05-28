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

export type ExportPickedImageAsPng = (uri: string) => Promise<string>;

interface SupportedPickedImageFormat {
  mimeType: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
}

const JPEG_FORMAT: SupportedPickedImageFormat = {
  mimeType: "image/jpeg",
  extension: "jpg",
};

const PNG_FORMAT: SupportedPickedImageFormat = {
  mimeType: "image/png",
  extension: "png",
};

function extensionFromPath(path: string | null | undefined): string | null {
  const match = path?.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function supportedFormatForExtension(extension: string | null): SupportedPickedImageFormat | null {
  if (extension === "jpg" || extension === "jpeg") {
    return JPEG_FORMAT;
  }
  if (extension === "png") {
    return PNG_FORMAT;
  }
  return null;
}

function supportedFormatForMimeType(
  mimeType: string | null | undefined,
): SupportedPickedImageFormat | null {
  const normalizedMimeType = mimeType?.toLowerCase();
  if (normalizedMimeType === "image/jpeg" || normalizedMimeType === "image/jpg") {
    return JPEG_FORMAT;
  }
  if (normalizedMimeType === "image/png") {
    return PNG_FORMAT;
  }
  return null;
}

function pickedAssetSupportedFormat(
  asset: ExpoImagePickerAssetLike,
): SupportedPickedImageFormat | null {
  const uriExtension = extensionFromPath(asset.uri);
  if (uriExtension) {
    return supportedFormatForExtension(uriExtension);
  }

  return (
    supportedFormatForExtension(extensionFromPath(asset.fileName)) ??
    supportedFormatForMimeType(asset.mimeType)
  );
}

function replaceFileExtension(
  fileName: string | null | undefined,
  extension: SupportedPickedImageFormat["extension"],
): string | null {
  if (!fileName) {
    return null;
  }

  return fileName.replace(/\.[^./\\]+$/, "") + `.${extension}`;
}

export async function normalizePickedImageAssetsWith(
  assets: readonly ExpoImagePickerAssetLike[],
  exportAsPng: ExportPickedImageAsPng,
): Promise<PickedImageAttachmentInput[]> {
  return await Promise.all(
    assets.map(async (asset) => {
      const supportedFormat = pickedAssetSupportedFormat(asset);
      if (supportedFormat) {
        return {
          source: { kind: "file_uri", uri: asset.uri },
          mimeType: supportedFormat.mimeType,
          fileName: replaceFileExtension(asset.fileName, supportedFormat.extension),
        };
      }

      const convertedUri = await exportAsPng(asset.uri);

      return {
        source: { kind: "file_uri", uri: convertedUri },
        mimeType: PNG_FORMAT.mimeType,
        fileName: replaceFileExtension(asset.fileName, PNG_FORMAT.extension),
      };
    }),
  );
}
