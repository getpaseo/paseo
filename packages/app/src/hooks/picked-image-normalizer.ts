export type PickedImageSource = { kind: "file_uri"; uri: string } | { kind: "blob"; blob: Blob };

export interface PickedImageAttachmentInput {
  source: PickedImageSource;
  mimeType: string;
  fileName?: string | null;
}

export interface ExpoImagePickerAssetLike {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  file?: File | null;
  /** Pixel size reported by the picker; 0 or missing when the system did not provide it. */
  width?: number | null;
  height?: number | null;
}

/**
 * Longest edge, in pixels, of an image attached from a phone. Models downscale
 * larger images anyway, and full-resolution photos exceed the message size limit
 * once they are inlined in the send request.
 */
export const MAX_PICKED_IMAGE_EDGE = 2000;
const JPEG_COMPRESS = 0.85;

export interface RenderPickedImageOptions {
  format: "jpeg" | "png";
  /** Quality for JPEG output, 0..1. */
  compress: number;
  /** Fit the longest edge to this size; null keeps the original size. */
  resize: { width: number } | { height: number } | null;
}

export type RenderPickedImage = (uri: string, options: RenderPickedImageOptions) => Promise<string>;

interface SupportedPickedImageFormat {
  mimeType: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
  render: RenderPickedImageOptions["format"];
}

const JPEG_FORMAT: SupportedPickedImageFormat = {
  mimeType: "image/jpeg",
  extension: "jpg",
  render: "jpeg",
};

const PNG_FORMAT: SupportedPickedImageFormat = {
  mimeType: "image/png",
  extension: "png",
  render: "png",
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
  const uriFormat = supportedFormatForExtension(uriExtension);
  if (uriExtension && !uriFormat) {
    return null;
  }

  return (
    supportedFormatForMimeType(asset.mimeType) ??
    supportedFormatForExtension(extensionFromPath(asset.fileName)) ??
    uriFormat
  );
}

function isHeifAsset(asset: ExpoImagePickerAssetLike): boolean {
  const mimeType = asset.mimeType?.toLowerCase();
  if (mimeType === "image/heic" || mimeType === "image/heif") {
    return true;
  }
  return [asset.uri, asset.fileName].some((path) => {
    const extension = extensionFromPath(path);
    return extension === "heic" || extension === "heif";
  });
}

/**
 * Camera photos (HEIC on iPhone) have no transparency, so JPEG keeps them small.
 * Other unsupported formats may carry alpha and become lossless PNG.
 */
function convertedFormat(asset: ExpoImagePickerAssetLike): SupportedPickedImageFormat {
  return isHeifAsset(asset) ? JPEG_FORMAT : PNG_FORMAT;
}

function resizeToFit(asset: ExpoImagePickerAssetLike): RenderPickedImageOptions["resize"] {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  if (width <= 0 || height <= 0 || Math.max(width, height) <= MAX_PICKED_IMAGE_EDGE) {
    return null;
  }
  return width >= height ? { width: MAX_PICKED_IMAGE_EDGE } : { height: MAX_PICKED_IMAGE_EDGE };
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
  render: RenderPickedImage,
): Promise<PickedImageAttachmentInput[]> {
  return await Promise.all(
    assets.map(async (asset) => {
      const supportedFormat = pickedAssetSupportedFormat(asset);
      const resize = resizeToFit(asset);
      if (supportedFormat && !resize) {
        return {
          source: { kind: "file_uri", uri: asset.uri },
          mimeType: supportedFormat.mimeType,
          fileName: replaceFileExtension(asset.fileName, supportedFormat.extension),
        };
      }

      const outputFormat = supportedFormat ?? convertedFormat(asset);
      const renderedUri = await render(asset.uri, {
        format: outputFormat.render,
        compress: JPEG_COMPRESS,
        resize,
      });

      return {
        source: { kind: "file_uri", uri: renderedUri },
        mimeType: outputFormat.mimeType,
        fileName: replaceFileExtension(asset.fileName, outputFormat.extension),
      };
    }),
  );
}
