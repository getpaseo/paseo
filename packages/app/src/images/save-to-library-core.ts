import { parseDataUrl } from "@/attachments/utils";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpg",
  "jpeg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpg": "jpg",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "image/x-ms-bmp": "bmp",
  "image/x-tiff": "tiff",
};

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super("Photo library permission was not granted.");
    this.name = "ImageLibraryPermissionError";
  }
}

export interface SaveImageInput {
  uri: string;
  mimeType?: string;
}

export interface DownloadedImage {
  uri: string;
  mimeType?: string | null;
  headers?: Readonly<Record<string, string>>;
}

export interface DownloadImageInput {
  uri: string;
  targetUri: string;
}

export interface MoveImageInput {
  from: string;
  to: string;
}

export interface CopyImageInput {
  from: string;
  to: string;
}

export interface WriteBase64ImageInput {
  uri: string;
  base64: string;
}

export interface ImageLibraryPort {
  readonly requiresWritePermission: boolean;
  isAvailable(): Promise<boolean>;
  requestWritePermission(): Promise<boolean>;
  createTemporaryUri(extension: string): string;
  downloadImage(input: DownloadImageInput): Promise<DownloadedImage>;
  moveImage(input: MoveImageInput): Promise<void>;
  copyImage(input: CopyImageInput): Promise<void>;
  writeBase64Image(input: WriteBase64ImageInput): Promise<void>;
  deleteImage(uri: string): Promise<void>;
  saveToLibrary(uri: string): Promise<void>;
}

interface LocalImage {
  uri: string;
  shouldDelete: boolean;
}

async function deleteTemporaryImages(
  port: ImageLibraryPort,
  uris: Iterable<string>,
): Promise<void> {
  let firstError: unknown;
  let failed = false;
  for (const uri of new Set(uris)) {
    try {
      await port.deleteImage(uri);
    } catch (error) {
      if (!failed) {
        firstError = error;
        failed = true;
      }
    }
  }
  if (failed) {
    throw firstError;
  }
}

async function deleteTemporaryImagesAfterFailure(
  port: ImageLibraryPort,
  uris: Iterable<string>,
  error: unknown,
): Promise<never> {
  try {
    await deleteTemporaryImages(port, uris);
  } catch {
    // Preserve the materialization error instead of replacing it with a cleanup failure.
  }
  throw error;
}

async function materializeTemporaryImage(
  port: ImageLibraryPort,
  extension: string,
  materialize: (uri: string) => Promise<void>,
): Promise<LocalImage> {
  const localUri = port.createTemporaryUri(extension);
  try {
    await materialize(localUri);
  } catch (error) {
    return await deleteTemporaryImagesAfterFailure(port, [localUri], error);
  }
  return { uri: localUri, shouldDelete: true };
}

function getImageExtension(uri: string, mimeType?: string | null): string {
  const pathname = uri.split(/[?#]/, 1)[0] ?? "";
  const extension = pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (extension && IMAGE_EXTENSIONS.has(extension)) {
    return extension;
  }
  const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_TYPE_EXTENSIONS[normalizedMimeType] ?? "jpg";
}

function getHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === normalizedName,
  )?.[1];
}

async function resolveDataImage(
  input: SaveImageInput,
  port: ImageLibraryPort,
): Promise<LocalImage> {
  const dataImage = parseDataUrl(input.uri);
  const extension = getImageExtension("", dataImage.mimeType);
  return await materializeTemporaryImage(port, extension, async (localUri) => {
    await port.writeBase64Image({ uri: localUri, base64: dataImage.base64 });
  });
}

async function resolveRemoteImage(
  input: SaveImageInput,
  port: ImageLibraryPort,
): Promise<LocalImage> {
  const temporaryDownloadUri = port.createTemporaryUri("download");
  const temporaryUris = new Set([temporaryDownloadUri]);
  try {
    const download = await port.downloadImage({
      uri: input.uri,
      targetUri: temporaryDownloadUri,
    });
    temporaryUris.add(download.uri);
    const savedExtension = getImageExtension(
      input.uri,
      download.mimeType ?? getHeader(download.headers, "content-type") ?? input.mimeType,
    );
    const localUri = port.createTemporaryUri(savedExtension);
    temporaryUris.add(localUri);
    await port.moveImage({ from: download.uri, to: localUri });
    await deleteTemporaryImages(port, [temporaryDownloadUri, download.uri]);
    temporaryUris.delete(temporaryDownloadUri);
    temporaryUris.delete(download.uri);
    temporaryUris.delete(localUri);
    return { uri: localUri, shouldDelete: true };
  } catch (error) {
    return await deleteTemporaryImagesAfterFailure(port, temporaryUris, error);
  }
}

async function resolveLocalImage(
  input: SaveImageInput,
  port: ImageLibraryPort,
): Promise<LocalImage> {
  if (/^data:image\//i.test(input.uri.trim())) {
    return await resolveDataImage(input, port);
  }

  if (/^https?:\/\//i.test(input.uri)) {
    return await resolveRemoteImage(input, port);
  }

  const extension = getImageExtension(input.uri, input.mimeType);
  const hasUsableExtension =
    getImageExtension(input.uri, null) !== "jpg" || /\.jpe?g(?:[?#]|$)/i.test(input.uri);
  if (input.uri.startsWith("file://") && hasUsableExtension) {
    return { uri: input.uri, shouldDelete: false };
  }

  return await materializeTemporaryImage(port, extension, async (localUri) => {
    await port.copyImage({ from: input.uri, to: localUri });
  });
}

export async function saveImageToLibraryWithPort(
  input: SaveImageInput,
  port: ImageLibraryPort,
): Promise<void> {
  if (!(await port.isAvailable())) {
    throw new Error("Photo library is unavailable.");
  }

  if (port.requiresWritePermission && !(await port.requestWritePermission())) {
    throw new ImageLibraryPermissionError();
  }

  const localImage = await resolveLocalImage(input, port);
  let saveError: unknown;
  let saveFailed = false;
  try {
    await port.saveToLibrary(localImage.uri);
  } catch (error) {
    saveError = error;
    saveFailed = true;
  }
  if (localImage.shouldDelete) {
    try {
      await port.deleteImage(localImage.uri);
    } catch {
      // The photo-library write result is authoritative; cache cleanup is best-effort.
    }
  }
  if (saveFailed) {
    throw saveError;
  }
}
