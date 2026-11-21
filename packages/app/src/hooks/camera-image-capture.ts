import type {
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
} from "./image-attachment-picker";

export type CameraCaptureResult =
  | { canceled: true }
  | { canceled: false; assets: readonly ExpoImagePickerAssetLike[] };

export interface CameraCaptureAdapter {
  ensureCameraPermission: () => Promise<boolean>;
  /**
   * Android can kill the app while the system camera is in front. The photo the
   * user took is then handed back on the next launch instead of to the original call.
   */
  getPendingResult: () => Promise<CameraCaptureResult | null>;
  launchCamera: () => Promise<CameraCaptureResult>;
  normalizeAssets: (
    assets: readonly ExpoImagePickerAssetLike[],
  ) => Promise<PickedImageAttachmentInput[]>;
}

export async function captureImageWithCamera(
  adapter: CameraCaptureAdapter,
): Promise<PickedImageAttachmentInput[] | null> {
  if (!(await adapter.ensureCameraPermission())) {
    return null;
  }

  const pendingResult = await adapter.getPendingResult();
  if (pendingResult && !pendingResult.canceled) {
    return await adapter.normalizeAssets(pendingResult.assets);
  }

  const result = await adapter.launchCamera();
  if (result.canceled) {
    return null;
  }

  return await adapter.normalizeAssets(result.assets);
}
