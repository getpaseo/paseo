import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Platform } from "react-native";
import {
  ImageLibraryPermissionError,
  saveImageToLibraryWithPort,
  type ImageLibraryPort,
  type SaveImageInput,
} from "./save-to-library-core";

export { ImageLibraryPermissionError };

function createTemporaryUri(extension: string): string {
  if (!FileSystem.cacheDirectory) {
    throw new Error("Image cache directory is unavailable.");
  }
  return `${FileSystem.cacheDirectory}paseo-image-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
}

const imageLibraryPort: ImageLibraryPort = {
  requiresWritePermission: Platform.OS === "ios" || Platform.OS === "android",
  async isAvailable() {
    return await MediaLibrary.isAvailableAsync();
  },
  async requestWritePermission() {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    return permission.granted;
  },
  createTemporaryUri,
  async downloadImage(input) {
    return await FileSystem.downloadAsync(input.uri, input.targetUri);
  },
  async moveImage(input) {
    await FileSystem.moveAsync(input);
  },
  async copyImage(input) {
    await FileSystem.copyAsync(input);
  },
  async writeBase64Image(input) {
    await FileSystem.writeAsStringAsync(input.uri, input.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  },
  async deleteImage(uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
  async saveToLibrary(uri) {
    await MediaLibrary.saveToLibraryAsync(uri);
  },
};

export async function saveImageToLibrary(input: SaveImageInput): Promise<void> {
  await saveImageToLibraryWithPort(input, imageLibraryPort);
}
