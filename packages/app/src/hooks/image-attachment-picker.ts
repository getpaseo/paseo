import type { DesktopDialogBridge } from "@/desktop/host";
import { RASTER_IMAGE_FILE_EXTENSIONS, resolveRasterImageMimeType } from "@/attachments/file-types";
import { getFileNameFromPath } from "@/attachments/utils";
import { i18n } from "@/i18n/i18next";
import { isAbsolutePath } from "@/utils/path";

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
}

function shouldTreatAsFileUri(uri: string): boolean {
  return uri.startsWith("file://") || isAbsolutePath(uri);
}

async function blobFromUri(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Failed to read picked image from '${uri}'.`);
  }
  return await response.blob();
}

function requirePickedImageMimeType(input: {
  mimeType?: string | null;
  path?: string | null;
}): string {
  const mimeType = resolveRasterImageMimeType(input);
  if (!mimeType) {
    throw new Error(`Unsupported image type for '${input.path ?? "selected image"}'.`);
  }
  return mimeType;
}

export async function normalizePickedImageAssets(
  assets: readonly ExpoImagePickerAssetLike[],
): Promise<PickedImageAttachmentInput[]> {
  return await Promise.all(
    assets.map(async (asset) => {
      if (asset.file instanceof Blob) {
        const fileName = asset.fileName ?? asset.file.name ?? null;
        return {
          source: { kind: "blob", blob: asset.file },
          mimeType: requirePickedImageMimeType({
            mimeType: asset.mimeType || asset.file.type,
            path: fileName ?? asset.uri,
          }),
          fileName,
        };
      }

      if (shouldTreatAsFileUri(asset.uri)) {
        return {
          source: { kind: "file_uri", uri: asset.uri },
          mimeType: requirePickedImageMimeType({
            mimeType: asset.mimeType,
            path: asset.fileName ?? asset.uri,
          }),
          fileName: asset.fileName ?? null,
        };
      }

      const blob = await blobFromUri(asset.uri);
      return {
        source: { kind: "blob", blob },
        mimeType: requirePickedImageMimeType({
          mimeType: asset.mimeType || blob.type,
          path: asset.fileName ?? asset.uri,
        }),
        fileName: asset.fileName ?? null,
      };
    }),
  );
}

function normalizeDesktopDialogSelection(selection: string | string[] | null): string[] {
  if (!selection) {
    return [];
  }
  return Array.isArray(selection) ? selection : [selection];
}

export async function pickImagesWithDesktopDialog(
  dialog: DesktopDialogBridge | null | undefined,
): Promise<PickedImageAttachmentInput[]> {
  const options = {
    directory: false,
    multiple: true,
    filters: [
      {
        name: i18n.t("imageAttachmentPicker.dialogFilterName"),
        extensions: RASTER_IMAGE_FILE_EXTENSIONS,
      },
    ],
    title: i18n.t("imageAttachmentPicker.dialogTitle"),
  };

  const dialogOpen = dialog?.open;
  if (typeof dialogOpen !== "function") {
    throw new Error("Desktop dialog API is not available.");
  }

  return normalizeDesktopDialogSelection(await dialogOpen(options)).map((path) => {
    const mimeType = resolveRasterImageMimeType({ path });
    if (!mimeType) {
      throw new Error(`Unsupported image type for '${path}'.`);
    }
    return {
      source: { kind: "file_uri" as const, uri: path },
      mimeType,
      fileName: getFileNameFromPath(path),
    };
  });
}
