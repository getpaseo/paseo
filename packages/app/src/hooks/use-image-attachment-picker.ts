import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  normalizePickedImageAssets,
  pickImagesWithDesktopDialog,
  type PickedImageAttachmentInput,
} from "@/hooks/image-attachment-picker";
import { isWeb } from "@/constants/platform";
import { captureImageWithCamera, type CameraCaptureResult } from "@/hooks/camera-image-capture";

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  takePhoto: () => Promise<PickedImageAttachmentInput[] | null>;
}

function toCameraCaptureResult(
  result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null,
): CameraCaptureResult | null {
  if (!result || !("canceled" in result)) {
    return null;
  }
  return result.canceled ? { canceled: true } : { canceled: false, assets: result.assets };
}

export function useImageAttachmentPicker(): UseImageAttachmentPickerResult {
  const { t } = useTranslation();
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
  const [cameraPermission, requestCameraPermission] = ImagePicker.useCameraPermissions();
  const isPickingRef = useRef(false);

  const ensurePermission = useCallback(async () => {
    let currentPermission = mediaPermission;

    if (
      !currentPermission ||
      currentPermission.status === ImagePicker.PermissionStatus.UNDETERMINED
    ) {
      currentPermission = await requestMediaPermission();
    } else if (!currentPermission.granted) {
      currentPermission = await requestMediaPermission();
    }

    if (!currentPermission?.granted) {
      Alert.alert(
        t("imageAttachmentPicker.permissionTitle"),
        t("imageAttachmentPicker.permissionMessage"),
      );
      return false;
    }

    return true;
  }, [mediaPermission, requestMediaPermission, t]);

  const pickImages = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }

    isPickingRef.current = true;

    try {
      if (isWeb && isElectronRuntime()) {
        const selectedImages = await pickImagesWithDesktopDialog(getDesktopHost()?.dialog);
        if (selectedImages.length === 0) {
          return null;
        }
        return selectedImages;
      }

      const hasPermission = await ensurePermission();
      if (!hasPermission) {
        return null;
      }

      const pendingResult = await ImagePicker.getPendingResultAsync();
      if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
        return await normalizePickedImageAssets(pendingResult.assets);
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (result.canceled) {
        return null;
      }

      return await normalizePickedImageAssets(result.assets);
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to pick image:", error);
      Alert.alert(t("imageAttachmentPicker.errorTitle"), t("imageAttachmentPicker.failedToSelect"));
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensurePermission, t]);

  const ensureCameraPermission = useCallback(async () => {
    const currentPermission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();

    if (!currentPermission.granted) {
      Alert.alert(
        t("imageAttachmentPicker.permissionTitle"),
        t("imageAttachmentPicker.cameraPermissionMessage"),
      );
      return false;
    }

    return true;
  }, [cameraPermission, requestCameraPermission, t]);

  const takePhoto = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }

    isPickingRef.current = true;

    try {
      return await captureImageWithCamera({
        ensureCameraPermission,
        getPendingResult: async () =>
          toCameraCaptureResult(await ImagePicker.getPendingResultAsync()),
        launchCamera: async () => {
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"] as ImagePicker.MediaType[],
            quality: 0.8,
          });
          return toCameraCaptureResult(result) ?? { canceled: true };
        },
        normalizeAssets: normalizePickedImageAssets,
      });
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to take photo:", error);
      Alert.alert(
        t("imageAttachmentPicker.errorTitle"),
        t("imageAttachmentPicker.failedToCapture"),
      );
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensureCameraPermission, t]);

  return { pickImages, takePhoto };
}
