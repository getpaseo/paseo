import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";

type ImagePickerSuccessResult = ImagePicker.ImagePickerSuccessResult;

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<ImagePickerSuccessResult | null>;
}

export function useImageAttachmentPicker(): UseImageAttachmentPickerResult {
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
  const isPickingRef = useRef(false);

  const ensurePermission = useCallback(async () => {
    let currentPermission = mediaPermission;

    if (!currentPermission || currentPermission.status === "undetermined") {
      currentPermission = await requestMediaPermission();
    } else if (!currentPermission.granted) {
      currentPermission = await requestMediaPermission();
    }

    if (!currentPermission?.granted) {
      Alert.alert("Permission required", "Please allow access to your photo library to attach images.");
      return false;
    }

    return true;
  }, [mediaPermission, requestMediaPermission]);

  const pickImages = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }

    isPickingRef.current = true;

    try {
      const hasPermission = await ensurePermission();
      if (!hasPermission) {
        return null;
      }

      const pendingResult = await ImagePicker.getPendingResultAsync();
      if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
        return pendingResult as ImagePickerSuccessResult;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled) {
        return null;
      }

      return result;
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to pick image:", error);
      Alert.alert("Error", "Failed to select image");
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensurePermission]);

  return { pickImages };
}
