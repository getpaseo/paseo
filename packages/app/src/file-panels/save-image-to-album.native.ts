import * as MediaLibrary from "expo-media-library";
import { Platform } from "react-native";
import {
  needsPhotoLibraryPermission,
  PhotoLibraryPermissionError,
} from "./photo-library-permission";

/**
 * Copies a local image into the device photo library. The URI must point at a local file with an
 * image extension; the attachment store's preview URLs always do.
 */
export async function saveImageToAlbum(uri: string): Promise<void> {
  if (needsPhotoLibraryPermission(Platform.OS, Platform.Version)) {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) throw new PhotoLibraryPermissionError();
  }
  await MediaLibrary.Asset.create(uri);
}
