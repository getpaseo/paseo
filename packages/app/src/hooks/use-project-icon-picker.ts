import { useCallback, useRef } from "react";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

const PROJECT_ICON_SIZE = 128;
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export function useProjectIconPicker(): {
  pickProjectIcon: () => Promise<string | null>;
} {
  const isPickingRef = useRef(false);

  const pickProjectIcon = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }
    isPickingRef.current = true;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (result.canceled) {
        return null;
      }

      const asset = result.assets[0];
      if (!asset) {
        return null;
      }
      const mimeType = asset.mimeType?.toLowerCase();
      if (mimeType && !SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new Error("Choose a PNG or JPEG image.");
      }

      const edge = Math.min(asset.width, asset.height);
      const normalized = await manipulateAsync(
        asset.uri,
        [
          {
            crop: {
              originX: Math.floor((asset.width - edge) / 2),
              originY: Math.floor((asset.height - edge) / 2),
              width: edge,
              height: edge,
            },
          },
          { resize: { width: PROJECT_ICON_SIZE, height: PROJECT_ICON_SIZE } },
        ],
        { base64: true, compress: 1, format: SaveFormat.PNG },
      );
      if (!normalized.base64) {
        throw new Error("The selected image could not be processed.");
      }
      return normalized.base64;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  return { pickProjectIcon };
}
