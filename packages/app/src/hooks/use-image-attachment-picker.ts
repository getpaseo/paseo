import { useCallback, useRef } from "react";
import { Alert, Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  normalizePickedMediaAssets,
  pickImagesWithDesktopDialog,
  type PickedMediaAttachmentInput,
} from "@/hooks/image-attachment-picker";
import { isWeb } from "@/constants/platform";
import { resolveImagePickerMediaTypes } from "@/hooks/image-picker-media-types";

interface UseImageAttachmentPickerResult {
  pickMedia: () => Promise<PickedMediaAttachmentInput[] | null>;
}

export function useImageAttachmentPicker(): UseImageAttachmentPickerResult {
  const { t } = useTranslation();
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
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
      const permissionMessage =
        Platform.OS === "ios"
          ? t("imageAttachmentPicker.permissionMediaMessage")
          : t("imageAttachmentPicker.permissionMessage");
      Alert.alert(t("imageAttachmentPicker.permissionTitle"), permissionMessage);
      return false;
    }

    return true;
  }, [mediaPermission, requestMediaPermission, t]);

  const pickMedia = useCallback(async () => {
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
        return selectedImages.map((attachment) => ({ kind: "image" as const, attachment }));
      }

      const hasPermission = await ensurePermission();
      if (!hasPermission) {
        return null;
      }

      const pendingResult = await ImagePicker.getPendingResultAsync();
      if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
        return await normalizePickedMediaAssets(pendingResult.assets);
      }

      const mediaTypes = resolveImagePickerMediaTypes(Platform.OS);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes,
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled) {
        return null;
      }

      return await normalizePickedMediaAssets(result.assets);
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to pick media:", error);
      const errorMessage =
        Platform.OS === "ios"
          ? t("imageAttachmentPicker.failedToSelectMedia")
          : t("imageAttachmentPicker.failedToSelect");
      Alert.alert(t("imageAttachmentPicker.errorTitle"), errorMessage);
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensurePermission, t]);

  return { pickMedia };
}
