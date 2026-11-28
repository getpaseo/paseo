import { useCallback } from "react";
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
import { i18n } from "@/i18n/i18next";

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
}

let isPicking = false;

async function ensureMediaLibraryPermission(): Promise<boolean> {
  let permission = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  }
  if (!permission.granted) {
    Alert.alert(
      i18n.t("imageAttachmentPicker.permissionTitle"),
      i18n.t("imageAttachmentPicker.permissionMessage"),
    );
    return false;
  }
  return true;
}

/**
 * Opens the app's image picker: the desktop file dialog in Electron, the photo library on
 * iOS and Android, and the browser file chooser on web. Resolves null when the user cancels,
 * denies access, or another pick is already open. Rejects when reading the selection fails.
 */
export async function pickImageAttachments(): Promise<PickedImageAttachmentInput[] | null> {
  if (isPicking) {
    return null;
  }
  isPicking = true;
  try {
    if (isWeb && isElectronRuntime()) {
      const selectedImages = await pickImagesWithDesktopDialog(getDesktopHost()?.dialog);
      return selectedImages.length === 0 ? null : selectedImages;
    }

    if (!(await ensureMediaLibraryPermission())) {
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
  } finally {
    isPicking = false;
  }
}

export function useImageAttachmentPicker(): UseImageAttachmentPickerResult {
  const { t } = useTranslation();

  const pickImages = useCallback(async () => {
    try {
      return await pickImageAttachments();
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to pick image:", error);
      Alert.alert(t("imageAttachmentPicker.errorTitle"), t("imageAttachmentPicker.failedToSelect"));
      return null;
    }
  }, [t]);

  return { pickImages };
}
