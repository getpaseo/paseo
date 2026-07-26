import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

const MAX_CUSTOM_THEME_BYTES = 64 * 1024;

export async function pickCustomThemeJson(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "application/json",
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) {
    return null;
  }
  const asset = result.assets[0];
  if (!asset) {
    return null;
  }
  const file = new File(asset.uri);
  if (file.size > MAX_CUSTOM_THEME_BYTES) {
    throw new RangeError("Theme files must be smaller than 64 KB");
  }
  return await file.text();
}
