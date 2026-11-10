import * as ImagePicker from "expo-image-picker";
import type { PickImagesOptions, PickedImage } from "@getpaseo/plugin/client/react-native";
import { toPickedImage } from "./picked-image";

/** Surfaces to the plugin by `name`; it cannot import host classes. */
class PluginImagePermissionError extends Error {
  constructor() {
    super("Photo library access is not allowed.");
    this.name = "PluginImagePermissionError";
  }
}

/** The photo library, with bytes: a plugin cannot read the returned file itself. */
export async function pickImages(options: PickImagesOptions = {}): Promise<PickedImage[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PluginImagePermissionError();
  const multiple = options.multiple === true;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: multiple,
    ...(multiple && options.limit ? { selectionLimit: options.limit } : {}),
    base64: true,
  });
  if (result.canceled) return [];
  return result.assets.flatMap((asset) => toPickedImage(asset) ?? []);
}
