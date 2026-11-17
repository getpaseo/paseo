import { describe, expect, it } from "vitest";
import {
  captureImageWithCamera,
  type CameraCaptureAdapter,
  type CameraCaptureResult,
} from "./camera-image-capture";
import type {
  ExpoImagePickerAssetLike,
  PickedImageAttachmentInput,
} from "./image-attachment-picker";

const capturedAsset: ExpoImagePickerAssetLike = {
  uri: "file:///cache/ImagePicker/capture.jpg",
  mimeType: "image/jpeg",
  fileName: "capture.jpg",
};

function fakeCameraAdapter(input: {
  permissionGranted: boolean;
  pendingResult?: CameraCaptureResult | null;
  cameraResult: CameraCaptureResult;
}): CameraCaptureAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureCameraPermission: async () => {
      calls.push("ensureCameraPermission");
      return input.permissionGranted;
    },
    getPendingResult: async () => {
      calls.push("getPendingResult");
      return input.pendingResult ?? null;
    },
    launchCamera: async () => {
      calls.push("launchCamera");
      return input.cameraResult;
    },
    normalizeAssets: async (assets) => {
      calls.push("normalizeAssets");
      return assets.map(
        (asset): PickedImageAttachmentInput => ({
          source: { kind: "file_uri", uri: asset.uri },
          mimeType: asset.mimeType ?? "image/jpeg",
          fileName: asset.fileName ?? null,
        }),
      );
    },
  };
}

describe("captureImageWithCamera", () => {
  it("returns the captured photo as an image attachment input", async () => {
    const adapter = fakeCameraAdapter({
      permissionGranted: true,
      cameraResult: { canceled: false, assets: [capturedAsset] },
    });

    const result = await captureImageWithCamera(adapter);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImagePicker/capture.jpg" },
        mimeType: "image/jpeg",
        fileName: "capture.jpg",
      },
    ]);
    expect(adapter.calls).toEqual([
      "ensureCameraPermission",
      "getPendingResult",
      "launchCamera",
      "normalizeAssets",
    ]);
  });

  it("does not open the camera when permission is denied", async () => {
    const adapter = fakeCameraAdapter({
      permissionGranted: false,
      cameraResult: { canceled: false, assets: [capturedAsset] },
    });

    const result = await captureImageWithCamera(adapter);

    expect(result).toBeNull();
    expect(adapter.calls).toEqual(["ensureCameraPermission"]);
  });

  it("returns null when the user cancels the camera", async () => {
    const adapter = fakeCameraAdapter({
      permissionGranted: true,
      cameraResult: { canceled: true },
    });

    const result = await captureImageWithCamera(adapter);

    expect(result).toBeNull();
    expect(adapter.calls).toEqual(["ensureCameraPermission", "getPendingResult", "launchCamera"]);
  });

  it("recovers a photo taken before the app was restarted instead of reopening the camera", async () => {
    const adapter = fakeCameraAdapter({
      permissionGranted: true,
      pendingResult: { canceled: false, assets: [capturedAsset] },
      cameraResult: { canceled: true },
    });

    const result = await captureImageWithCamera(adapter);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImagePicker/capture.jpg" },
        mimeType: "image/jpeg",
        fileName: "capture.jpg",
      },
    ]);
    expect(adapter.calls).toEqual([
      "ensureCameraPermission",
      "getPendingResult",
      "normalizeAssets",
    ]);
  });
});
